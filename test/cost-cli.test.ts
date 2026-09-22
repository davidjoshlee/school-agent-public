import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>()
  return {
    ...actual,
    // The reconcile command's only gateway touchpoint: getGenerationInfo.
    // Mocked so the (zero-network) test suite never makes a real gateway call.
    createGateway: () => ({
      getGenerationInfo: async ({ id }: { id: string }) => {
        if (id === "gen_fails") {
          throw new Error("mock: generation not found")
        }
        return { totalCost: 0.0099 }
      },
    }),
  }
})

const { runCli } = await import("../src/cli.js")
const { createSchoolIndex } = await import("../src/store/db.js")

describe("school cost CLI", () => {
  it("prints grouped function/model totals, the cached split, and the grand total", async () => {
    // Given: an index seeded with usage across two functions/models, and a config with no cap.
    const root = await mkdtemp(join(tmpdir(), "school-agent-cost-cli-"))
    const configPath = join(root, "school.config.json")
    const indexPath = join(root, "index.db")
    await writeFile(
      configPath,
      JSON.stringify({
        vault: { path: root, gitInit: false },
        index: { path: indexPath },
      }),
      "utf8",
    )
    const index = createSchoolIndex({ path: indexPath })
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15)).toISOString()
    index.upsertTokenUsage({
      syncRunCanvasId: "run-1",
      model: "mock/model-a",
      functionName: "prepBrief",
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
      recordedAt: monthStart,
      costUsd: 0.5,
    })
    index.upsertTokenUsage({
      syncRunCanvasId: "run-2",
      model: "mock/model-b",
      functionName: "assignmentDraft",
      inputTokens: 300,
      outputTokens: 100,
      cachedInputTokens: 0,
      recordedAt: monthStart,
      costUsd: 1.5,
    })
    index.close()
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      // When: the cost command runs with its default (current-month) window.
      const exitCode = await runCli(["--config", configPath, "cost"])

      // Then: it succeeds and reports both groups plus a TOTAL row.
      expect(exitCode).toBe(0)
      const output = log.mock.calls.at(0)?.[0] as string
      expect(output).toContain("prepBrief\tmock/model-a\t100\t50\t20\t80\t0.5000")
      expect(output).toContain("assignmentDraft\tmock/model-b\t300\t100\t0\t300\t1.5000")
      expect(output).toContain("TOTAL\t\t400\t150\t20\t380\t2.0000")
    } finally {
      log.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("shows month-to-date spend against the cap when maxMonthlySpendUSD is configured", async () => {
    // Given: a config with a monthly spend cap and one usage row this month.
    const root = await mkdtemp(join(tmpdir(), "school-agent-cost-cli-cap-"))
    const configPath = join(root, "school.config.json")
    const indexPath = join(root, "index.db")
    await writeFile(
      configPath,
      JSON.stringify({
        vault: { path: root, gitInit: false },
        index: { path: indexPath },
        cost: { maxMonthlySpendUSD: 10 },
      }),
      "utf8",
    )
    const index = createSchoolIndex({ path: indexPath })
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15)).toISOString()
    index.upsertTokenUsage({
      syncRunCanvasId: "run-1",
      model: "mock/model-a",
      functionName: "prepBrief",
      inputTokens: 10,
      outputTokens: 10,
      cachedInputTokens: 0,
      recordedAt: monthStart,
      costUsd: 2.5,
    })
    index.close()
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      // When: the cost command runs.
      const exitCode = await runCli(["--config", configPath, "cost"])

      // Then: the cap line reports month-to-date spend against the configured cap.
      expect(exitCode).toBe(0)
      const output = log.mock.calls.at(0)?.[0] as string
      expect(output).toContain("Month-to-date spend: $2.50 of $10.00 cap")
    } finally {
      log.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("cost reconcile exits cleanly with a clear message when no gateway credentials are configured", async () => {
    // Given: a config with no cap, and no AI Gateway credentials in the environment.
    const root = await mkdtemp(join(tmpdir(), "school-agent-cost-reconcile-"))
    const configPath = join(root, "school.config.json")
    const indexPath = join(root, "index.db")
    await writeFile(
      configPath,
      JSON.stringify({
        vault: { path: root, gitInit: false },
        index: { path: indexPath },
      }),
      "utf8",
    )
    vi.stubEnv("AI_GATEWAY_API_KEY", "")
    vi.stubEnv("VERCEL_OIDC_TOKEN", "")
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      // When: cost reconcile runs.
      const exitCode = await runCli(["--config", configPath, "cost", "reconcile"])

      // Then: it does not crash — it reports non-zero with a clear message (via runCli's
      // standard error-to-exit-code handling), never an unhandled exception.
      expect(exitCode).toBe(1)
      expect(error).toHaveBeenCalledWith(expect.stringContaining("AI_GATEWAY_API_KEY"))
    } finally {
      error.mockRestore()
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("cost reconcile updates cost_usd/cost_source for reconciled rows and reports skips", async () => {
    // Given: credentials configured, and an index with one reconcilable row and one
    // whose gateway lookup will fail (per the mocked createGateway above).
    const root = await mkdtemp(join(tmpdir(), "school-agent-cost-reconcile-ok-"))
    const configPath = join(root, "school.config.json")
    const indexPath = join(root, "index.db")
    await writeFile(
      configPath,
      JSON.stringify({
        vault: { path: root, gitInit: false },
        index: { path: indexPath },
      }),
      "utf8",
    )
    const index = createSchoolIndex({ path: indexPath })
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 15),
    ).toISOString()
    index.upsertTokenUsage({
      syncRunCanvasId: "run-ok",
      model: "mock/model",
      functionName: "prepBrief",
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      recordedAt: monthStart,
      costUsd: 1,
      generationId: "gen_ok",
      costSource: "estimate",
    })
    index.upsertTokenUsage({
      syncRunCanvasId: "run-fails",
      model: "mock/model",
      functionName: "prepBrief",
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      recordedAt: monthStart,
      costUsd: 2,
      generationId: "gen_fails",
      costSource: "estimate",
    })
    index.close()
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key")
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      // When: cost reconcile runs.
      const exitCode = await runCli(["--config", configPath, "cost", "reconcile"])

      // Then: it succeeds, reconciling the one lookup that resolves and skipping the other.
      expect(exitCode).toBe(0)
      const output = log.mock.calls.at(0)?.[0] as string
      expect(output).toContain("Reconciled 1 of 2")
      expect(output).toContain("gen_fails")

      const after = createSchoolIndex({ path: indexPath })
      expect(after.tokenUsageForFunction("prepBrief")).toMatchObject({
        // tokenUsageForFunction returns the most-recently-written row (rowid DESC);
        // "run-fails" was written last and is untouched by the failed lookup.
        syncRunCanvasId: "run-fails",
        costUsd: 2,
        costSource: "estimate",
      })
      const summary = after.costSummary()
      expect(summary.groups).toContainEqual(
        expect.objectContaining({ costSource: "gateway", costUsd: 0.0099 }),
      )
      expect(summary.groups).toContainEqual(
        expect.objectContaining({ costSource: "estimate", costUsd: 2 }),
      )
      after.close()
    } finally {
      log.mockRestore()
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
})
