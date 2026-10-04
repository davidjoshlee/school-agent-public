import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { loadConfig } from "../../src/config/index.js"
import { type AiReadinessDependencies, checkAiReadiness } from "../../src/models/ai-readiness.js"

const directories: string[] = []

async function testConfig() {
  const directory = await mkdtemp(join(tmpdir(), "school-ai-readiness-"))
  directories.push(directory)
  const path = join(directory, "school.config.json")
  await writeFile(
    path,
    JSON.stringify({
      canvas: { baseUrl: "https://canvas.example.edu", tokenEnv: "CANVAS_TOKEN" },
      vault: { path: join(directory, "vault"), gitInit: false },
      index: { path: join(directory, "index.db") },
      courses: { mode: "list", allowlist: [] },
      models: {
        triage: "test/shared",
        generation: "test/text-one",
        functions: {
          extractSummary: "test/shared",
          prepBrief: "test/text-one",
          assignmentDraft: "test/text-two",
          assignmentDiscuss: "test/shared",
          coverageCompare: "test/text-two",
          playbookUpdate: "test/text-one",
        },
      },
    }),
  )
  return loadConfig(path)
}

const catalog = ["test/shared", "test/text-one", "test/text-two"].map((id) => ({
  id,
  type: "language",
}))

function dependencies(overrides: Partial<AiReadinessDependencies> = {}): AiReadinessDependencies {
  return {
    fetchCatalog: vi.fn(async () => catalog),
    generate: vi.fn(async () => "READY"),
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("AI readiness", () => {
  it("checks only the explicitly overridden model when a global override is supplied", async () => {
    const config = await testConfig()
    const generate = vi.fn(async () => "READY")
    const result = await checkAiReadiness(
      config,
      "synthetic-key",
      dependencies({ generate }),
      "test/shared",
    )
    expect(result.healthy).toBe(true)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledWith("test/shared", "synthetic-key", expect.any(AbortSignal))
  })
  it("rejects a missing or whitespace-only key without network access", async () => {
    const config = await testConfig()
    const fetchCatalog = vi.fn(async () => catalog)
    const result = await checkAiReadiness(config, "  \n", dependencies({ fetchCatalog }))
    expect(result.healthy).toBe(false)
    expect(result.findings[0]?.message).toContain("missing or blank")
    expect(fetchCatalog).not.toHaveBeenCalled()
  })

  it("rejects configured models missing from the public language-model catalogue", async () => {
    const config = await testConfig()
    const result = await checkAiReadiness(
      config,
      "synthetic-key",
      dependencies({ fetchCatalog: vi.fn(async () => [{ id: "test/shared", type: "language" }]) }),
    )
    expect(result.healthy).toBe(false)
    expect(result.findings.map(({ message }) => message).join(" ")).toContain("test/text-one")
  })

  it.each([
    [401, "authentication"],
    [402, "credits"],
    [429, "rate limit"],
    [404, "model was found"],
  ])("categorizes gateway status %i without exposing error details", async (status, guidance) => {
    const config = await testConfig()
    const secretBody = "provider response contains private detail"
    const result = await checkAiReadiness(
      config,
      "synthetic-key",
      dependencies({
        generate: vi.fn(async () => {
          throw Object.assign(new Error(secretBody), { statusCode: status })
        }),
      }),
    )
    expect(result.healthy).toBe(false)
    expect(result.findings.map(({ message }) => message).join(" ")).toContain(guidance)
    expect(result.findings.map(({ message }) => message).join(" ")).not.toContain(secretBody)
  })

  it("categorizes timeout failures and probes each distinct mapping exactly once", async () => {
    const config = await testConfig()
    const generate = vi.fn(async (modelId: string) => {
      if (modelId === "test/text-one")
        throw new DOMException("private timeout details", "TimeoutError")
      return "READY"
    })
    const result = await checkAiReadiness(config, "synthetic-key", dependencies({ generate }))
    expect(generate).toHaveBeenCalledTimes(3)
    expect(new Set(generate.mock.calls.map(([id]) => id)).size).toBe(3)
    expect(result.findings.map(({ message }) => message).join(" ")).toContain("timed out")
    expect(result.findings.map(({ message }) => message).join(" ")).not.toContain("private timeout")
  })

  it("reports success while clarifying that catalogue presence alone is not authentication", async () => {
    const config = await testConfig()
    const generate = vi.fn(async () => "READY")
    const result = await checkAiReadiness(config, "synthetic-key", dependencies({ generate }))
    expect(result.healthy).toBe(true)
    expect(result.findings[0]?.message).toContain("does not verify your key")
    expect(generate).toHaveBeenCalledTimes(3)
  })
})
