import { describe, expect, it } from "vitest"

import {
  GatewayNotConfiguredError,
  hasGatewayCredentials,
  reconcileTokenUsage,
} from "../src/engines/cost-reconcile.js"
import { createSchoolIndex } from "../src/store/db.js"

function seedRow(
  index: ReturnType<typeof createSchoolIndex>,
  overrides: {
    readonly syncRunCanvasId: string
    readonly generationId?: string | null
    readonly recordedAt?: string
  },
): void {
  index.upsertTokenUsage({
    syncRunCanvasId: overrides.syncRunCanvasId,
    model: "mock/model",
    functionName: "prepBrief",
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 0,
    recordedAt: overrides.recordedAt ?? "2026-09-05T00:00:00.000Z",
    costUsd: 1.23,
    generationId: overrides.generationId ?? null,
    costSource: "estimate",
  })
}

describe("reconcileTokenUsage", () => {
  it("overwrites cost_usd with the gateway's totalCost and marks the row gateway-sourced", async () => {
    // Given: a row carrying a captured generation id.
    const index = createSchoolIndex({ path: ":memory:" })
    seedRow(index, { syncRunCanvasId: "run-1", generationId: "gen_abc" })

    // When: reconcile runs against a lookup that resolves a known cost.
    const summary = await reconcileTokenUsage({
      index,
      since: "2026-01-01T00:00:00.000Z",
      lookup: async ({ id }) => {
        expect(id).toBe("gen_abc")
        return { totalCost: 0.0042 }
      },
    })

    // Then: the row's cost is overwritten and stamped "gateway".
    expect(summary).toEqual({ candidateCount: 1, reconciled: 1, skipped: [] })
    const logged = index.tokenUsageForFunction("prepBrief")
    expect(logged).toMatchObject({ costUsd: 0.0042, costSource: "gateway" })
    index.close()
  })

  it("skips a row whose lookup fails and leaves it unchanged, without throwing the whole command", async () => {
    // Given: a row carrying a generation id the gateway will reject.
    const index = createSchoolIndex({ path: ":memory:" })
    seedRow(index, { syncRunCanvasId: "run-2", generationId: "gen_too_old" })

    // When: reconcile runs against a lookup that throws (unauthorized, expired id, rate limited, etc.).
    const summary = await reconcileTokenUsage({
      index,
      since: "2026-01-01T00:00:00.000Z",
      lookup: async () => {
        throw new Error("404: generation not found")
      },
    })

    // Then: the failure is counted as skipped, never thrown, and the row is untouched.
    expect(summary.candidateCount).toBe(1)
    expect(summary.reconciled).toBe(0)
    expect(summary.skipped).toEqual([
      { generationId: "gen_too_old", reason: "404: generation not found" },
    ])
    const logged = index.tokenUsageForFunction("prepBrief")
    expect(logged).toMatchObject({ costUsd: 1.23, costSource: "estimate" })
    index.close()
  })

  it("continues past a failed row to reconcile the rest", async () => {
    // Given: two candidate rows, one of which will fail lookup.
    const index = createSchoolIndex({ path: ":memory:" })
    seedRow(index, { syncRunCanvasId: "run-3", generationId: "gen_bad" })
    seedRow(index, { syncRunCanvasId: "run-4", generationId: "gen_good" })

    // When: reconcile runs with a lookup that fails only for one id.
    const summary = await reconcileTokenUsage({
      index,
      since: "2026-01-01T00:00:00.000Z",
      lookup: async ({ id }) => {
        if (id === "gen_bad") {
          throw new Error("rate limited")
        }
        return { totalCost: 0.01 }
      },
    })

    // Then: one reconciled, one skipped — the command keeps going.
    expect(summary.candidateCount).toBe(2)
    expect(summary.reconciled).toBe(1)
    expect(summary.skipped).toEqual([{ generationId: "gen_bad", reason: "rate limited" }])
    index.close()
  })

  it("excludes rows with no captured generation id and rows outside the window", async () => {
    // Given: a row with no generation id, and a row dated before the window.
    const index = createSchoolIndex({ path: ":memory:" })
    seedRow(index, { syncRunCanvasId: "run-no-gen", generationId: null })
    seedRow(index, {
      syncRunCanvasId: "run-too-old",
      generationId: "gen_old",
      recordedAt: "2025-01-01T00:00:00.000Z",
    })

    // When: reconcile runs with a window starting after "run-too-old".
    const summary = await reconcileTokenUsage({
      index,
      since: "2026-01-01T00:00:00.000Z",
      lookup: async () => ({ totalCost: 99 }),
    })

    // Then: neither row is a candidate.
    expect(summary).toEqual({ candidateCount: 0, reconciled: 0, skipped: [] })
    index.close()
  })
})

describe("hasGatewayCredentials", () => {
  it("is false when neither env var is set", () => {
    expect(hasGatewayCredentials({})).toBe(false)
  })

  it("is true when AI_GATEWAY_API_KEY is set", () => {
    expect(hasGatewayCredentials({ AI_GATEWAY_API_KEY: "key" })).toBe(true)
  })

  it("is true when VERCEL_OIDC_TOKEN is set", () => {
    expect(hasGatewayCredentials({ VERCEL_OIDC_TOKEN: "token" })).toBe(true)
  })
})

describe("GatewayNotConfiguredError", () => {
  it("carries a clear, actionable message", () => {
    expect(new GatewayNotConfiguredError().message).toMatch(/AI_GATEWAY_API_KEY/)
  })
})
