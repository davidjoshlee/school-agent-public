import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { tool } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { RunNotFoundError, RunNotPendingApprovalError } from "../../src/agents/errors.js"
import type { AgentRunnerConfig } from "../../src/agents/runner.js"
import { AISDKAgentRunner } from "../../src/agents/runner.js"

/** Expected flat usage numbers surfaced through {@link AgentRunResult.usage}. */
const usage = { inputTokens: 10, outputTokens: 5 } as const
/**
 * The real `LanguageModelV4Usage` wire shape a provider's `doGenerate`
 * returns: nested `{ total, ... }` objects, not flat numbers. A flat
 * `{ inputTokens: number }` (the shape used before this fixture was
 * corrected) silently fails schema validation and every count comes back
 * `undefined`, so `usageFrom` degrades to `null` unnoticed.
 */
const providerUsage = {
  inputTokens: {
    total: usage.inputTokens,
    noCache: usage.inputTokens,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: usage.outputTokens, text: usage.outputTokens, reasoning: undefined },
} as const

interface Fixture {
  config: AgentRunnerConfig
  executed: () => number
}

/**
 * A keyless, deterministic "hello agent with one gated tool". The fake model
 * emits `gated_tool` on its first call (so the run parks at a gate) and a final
 * text message on every later call (so an approved or revised run completes).
 */
function createFixture(runsDir: string): Fixture {
  let modelCalls = 0
  let executions = 0

  const gatedTool = tool({
    description: "A gated hello tool.",
    inputSchema: z.object({ greeting: z.string().min(1) }),
    execute: async ({ greeting }) => {
      executions += 1
      return { echo: greeting, approved: true }
    },
  })

  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-hello",
    doGenerate: () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "gated_tool",
              input: JSON.stringify({ greeting: "hello from runner" }),
            },
          ],
          finishReason: { unified: "tool-calls" },
          usage: providerUsage,
        }
      }
      return {
        content: [{ type: "text", text: "done after approval" }],
        finishReason: { unified: "stop" },
        usage: providerUsage,
      }
    },
  })

  return {
    config: {
      runsDir,
      model,
      tools: { gated_tool: gatedTool },
      toolApproval: { gated_tool: "user-approval" },
    },
    executed: () => executions,
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "school-agent-runner-"))
}

describe("AISDKAgentRunner", () => {
  it("parks a gated run durably, then grants it from a fresh runner with intact state", async () => {
    const runsDir = await tempDir()
    try {
      const fixture = createFixture(runsDir)
      const runner = new AISDKAgentRunner(fixture.config)

      const run = await runner.run("run the gated hello")
      expect(run.status).toBe("pending_approval")
      expect(run.text).toBeNull()
      expect(run.pendingApproval).toMatchObject({ toolName: "gated_tool" })
      expect(fixture.executed()).toBe(0)

      // A separate runner instance (a different "process") reads the run purely
      // from the durable file — this is the kill-and-resume boundary.
      const freshRunner = new AISDKAgentRunner(fixture.config)
      const parked = await freshRunner.get(run.runId)
      expect(parked.status).toBe("pending_approval")
      expect(parked.pendingApproval.approvalId).toBeTruthy()

      const approved = await freshRunner.approve(run.runId)
      expect(approved.status).toBe("completed")
      expect(approved.text).toBe("done after approval")
      expect(approved.pendingApproval).toBeNull()
      expect(fixture.executed()).toBe(1)
      // The real per-generate() usage the SDK reported for the approval call.
      expect(approved.usage).toEqual({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: null,
        generationId: null,
      })

      const after = await freshRunner.get(run.runId)
      expect(after.status).toBe("completed")
      expect(after.resultText).toBe("done after approval")

      const raw = await readFile(join(runsDir, `${run.runId}.json`), "utf8")
      expect(JSON.parse(raw).resultText).toBe("done after approval")
    } finally {
      await rm(runsDir, { recursive: true, force: true })
    }
  })

  it("re-submits follow-up feedback through revise and completes", async () => {
    const runsDir = await tempDir()
    try {
      const fixture = createFixture(runsDir)
      const runner = new AISDKAgentRunner(fixture.config)

      const run = await runner.run("draft the brief")
      expect(run.status).toBe("pending_approval")

      const revised = await runner.revise(run.runId, "make it shorter")
      expect(revised.status).toBe("completed")
      expect(revised.text).toBe("done after approval")
    } finally {
      await rm(runsDir, { recursive: true, force: true })
    }
  })

  it("refuses to approve a run that is not parked at a gate", async () => {
    const runsDir = await tempDir()
    try {
      const fixture = createFixture(runsDir)
      const runner = new AISDKAgentRunner(fixture.config)

      const run = await runner.run("run the gated hello")
      await runner.approve(run.runId)

      await expect(runner.approve(run.runId)).rejects.toBeInstanceOf(RunNotPendingApprovalError)
    } finally {
      await rm(runsDir, { recursive: true, force: true })
    }
  })

  it("reports a missing run as RunNotFoundError", async () => {
    const runsDir = await tempDir()
    try {
      const fixture = createFixture(runsDir)
      const runner = new AISDKAgentRunner(fixture.config)
      await expect(runner.get("does-not-exist")).rejects.toBeInstanceOf(RunNotFoundError)
    } finally {
      await rm(runsDir, { recursive: true, force: true })
    }
  })

  it("lists zero runs when the store is empty and the directory is absent", async () => {
    const runsDir = await tempDir()
    try {
      const fixture = createFixture(runsDir)
      const runner = new AISDKAgentRunner(fixture.config)
      await expect(runner.list()).resolves.toEqual([])
    } finally {
      await rm(runsDir, { recursive: true, force: true })
    }
  })

  it("captures the gateway's inline generationId from providerMetadata onto usage", async () => {
    const runsDir = await tempDir()
    try {
      const runner = new AISDKAgentRunner({
        runsDir,
        tools: {},
        model: new MockLanguageModelV4({
          provider: "mock",
          modelId: "mock-gateway",
          doGenerate: () => ({
            content: [{ type: "text", text: "done" }],
            finishReason: { unified: "stop" },
            usage: providerUsage,
            providerMetadata: { gateway: { generationId: "gen_abc123" } },
          }),
        }),
      })

      const run = await runner.run("hello")

      expect(run.status).toBe("completed")
      expect(run.usage).toEqual({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: null,
        generationId: "gen_abc123",
      })
    } finally {
      await rm(runsDir, { recursive: true, force: true })
    }
  })

  it("stores usage.generationId as null when providerMetadata carries no gateway generationId", async () => {
    const runsDir = await tempDir()
    try {
      const runner = new AISDKAgentRunner({
        runsDir,
        tools: {},
        model: new MockLanguageModelV4({
          provider: "mock",
          modelId: "mock-no-gateway",
          doGenerate: () => ({
            content: [{ type: "text", text: "done" }],
            finishReason: { unified: "stop" },
            usage: providerUsage,
          }),
        }),
      })

      const run = await runner.run("hello")

      expect(run.usage).toEqual({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: null,
        generationId: null,
      })
    } finally {
      await rm(runsDir, { recursive: true, force: true })
    }
  })

  it("aborts a generation that exceeds the configured timeout instead of hanging", async () => {
    const runsDir = await tempDir()
    try {
      // A provider whose generation never resolves — the exact hang the timeout guards.
      const model = new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-hang",
        doGenerate: () => new Promise(() => {}),
      })
      const config: AgentRunnerConfig = { runsDir, model, tools: {}, generateTimeoutMs: 50 }
      const runner = new AISDKAgentRunner(config)

      await expect(runner.run("hang please")).rejects.toMatchObject({
        name: "AgentTimeoutError",
      })
    } finally {
      await rm(runsDir, { recursive: true, force: true })
    }
  })
})
