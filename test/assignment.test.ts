import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { stepCountIs, tool } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { calculateTool } from "../src/agents/calculate-tool.js"
import { AISDKAgentRunner } from "../src/agents/runner.js"
import type { SchoolConfig } from "../src/config/index.js"
import {
  approveAssignment,
  assignmentProvenanceSchema,
  discussAssignment,
  draftAssignment,
  parseAssignmentProvenance,
  reviseAssignment,
} from "../src/engines/assignment.js"
import { SpendCapExceededError } from "../src/models/cost.js"
import { createSchoolIndex } from "../src/store/db.js"
import { coursePaths, xlsxSiblingPath } from "../src/store/paths.js"
import { createVaultFrontmatter, renderVaultDocument } from "../src/store/vault-document.js"
import { schoolConfig } from "./helpers/schoolConfig.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

/** Expected flat usage numbers surfaced through {@link AgentRunResult.usage}. */
const usage = { inputTokens: 10, outputTokens: 5 } as const
/**
 * The real `LanguageModelV4Usage` wire shape a provider's `doGenerate`
 * returns: nested `{ total, ... }` objects, not flat numbers. A flat
 * `{ inputTokens: number }` silently fails schema validation and every
 * count comes back `undefined`, so the runner's usage degrades to `null`
 * unnoticed.
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
const course = {
  code: "STRAT 101",
  canvasId: "course-17",
  canvasUrl: "https://canvas.example.invalid/courses/course-17",
  aiPolicy: "allowed" as const,
} as const
const assignment = {
  canvasId: "assignment-9",
  title: "Pricing Memo",
  canvasUrl: "https://canvas.example.invalid/assignments/assignment-9",
  groupCategoryId: "group-3",
} as const

function config(policy: "allowed" | "prohibited" = "allowed"): SchoolConfig {
  return schoolConfig({
    vaultPath: "unused",
    indexPath: ":memory:",
    pilotCourseId: null,
    canvas: { baseUrl: "https://canvas.example.invalid" },
    aiPolicyDefault: policy,
  })
}

function document(content: string): string {
  return renderVaultDocument(
    createVaultFrontmatter({
      canvasId: "fixture",
      canvasUrl: "https://canvas.example.invalid/resource",
      type: "fixture",
      content,
      source: "sync",
      status: "approved",
      aiPolicy: "allowed",
    }),
    content,
  )
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, document(content), "utf8")
}

async function fixtureVault(): Promise<string> {
  const root = await temporaryDirectory("school-agent-assignment-")
  const paths = coursePaths(root, course.code, course.canvasId)
  await put(paths.syllabus, "Week 1 pricing under uncertainty.")
  await put(join(paths.modules, "01-pricing", "case.md"), "Contribution margin case.")
  await put(join(paths.assignments, "pricing-memo.md"), "Write a pricing recommendation.")
  await put(
    paths.index,
    [
      "| title | type | dates | path | token estimate |",
      "| --- | --- | --- | --- | --- |",
      "| Pricing Memo | assignment | 2026-09-08 | assignments/pricing-memo.md | 30 |",
      "| Pricing Case | module | 2026-09-01 | modules/01-pricing/case.md | 30 |",
    ].join("\n"),
  )
  return root
}

function gatedRunner(runsDir: string): AISDKAgentRunner {
  let calls = 0
  const gate = tool({
    description: "Pause an assignment artifact for human approval.",
    inputSchema: z.object({ artifact: z.string().min(1) }),
    execute: async () => ({ parked: true }),
  })
  return new AISDKAgentRunner({
    runsDir,
    tools: { assignment_gate: gate },
    toolApproval: { assignment_gate: "user-approval" },
    model: new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock-assignment",
      doGenerate: ({ prompt }) => {
        // The self-review is a second, ungated model call; branch on its prompt
        // marker so the gated draft/revise call sequence below is undisturbed.
        if (JSON.stringify(prompt).includes("Draft under review")) {
          return {
            content: [{ type: "text", text: "**Verified**\n- Every requirement is addressed." }],
            finishReason: { unified: "stop" as const },
            usage: providerUsage,
          }
        }
        calls += 1
        const output =
          calls === 1
            ? "# Pricing Memo\n\nFirst pass."
            : calls === 3
              ? JSON.stringify(prompt).includes("USER_EDIT_TOKEN") &&
                JSON.stringify(prompt).includes("FEEDBACK_TOKEN")
                ? "# Pricing Memo\n\n<!-- coedit-inputs-present -->"
                : "# Pricing Memo\n\n<!-- coedit-inputs-missing -->"
              : calls === 5
                ? JSON.stringify(prompt).includes("final pass")
                  ? "# Pricing Memo\n\nThird pass.\n\n<!-- feedback-only-present -->"
                  : "# Pricing Memo\n\n<!-- feedback-only-missing -->"
                : "gate transition complete"
        const gated = calls === 1 || calls === 3 || calls === 5
        return {
          content: [
            { type: "text", text: output },
            ...(gated
              ? [
                  {
                    type: "tool-call" as const,
                    toolCallId: `gate-${calls}`,
                    toolName: "assignment_gate",
                    input: JSON.stringify({ artifact: "draft" }),
                  },
                ]
              : []),
          ],
          finishReason: { unified: gated ? "tool-calls" : "stop" },
          usage: providerUsage,
        }
      },
    }),
  })
}

describe("assignment provenance", () => {
  it("rejects a draft header missing its source paths", () => {
    // Given: an incomplete untrusted provenance header.
    const incomplete = { course: "STRAT 101" }

    // When: the engine validates it at the write boundary.
    const parsed = assignmentProvenanceSchema.safeParse(incomplete)

    // Then: an invalid header cannot reach the vault.
    expect(parsed.success).toBe(false)
  })
})

describe("assignment engine", () => {
  it("logs one assignmentDraft token_usage row combining the draft and self-review calls", async () => {
    // Given: a course vault and a config that prices the assignmentDraft model.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const runner = gatedRunner(join(root, ".agent-runs"))
    const pricedConfig: SchoolConfig = {
      ...config(),
      models: {
        ...config().models,
        functions: { ...config().models.functions, assignmentDraft: "google/gemini-3.7-flash" },
      },
    }
    try {
      // When: a first-pass draft (draft call + self-review call) is created.
      await draftAssignment({
        vaultRoot: root,
        config: pricedConfig,
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: one row is logged under assignmentDraft with the two calls'
      // token counts summed (never the review call's usage silently
      // overwriting the draft's under the shared run-id/model/function key).
      const logged = index.tokenUsageForFunction("assignmentDraft")
      expect(logged).toMatchObject({
        model: "google/gemini-3.7-flash",
        inputTokens: usage.inputTokens * 2,
        outputTokens: usage.outputTokens * 2,
      })
      expect(logged?.costUsd).toBeGreaterThan(0)
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("retries once when the draft model returns no text, then succeeds", async () => {
    // Given: a model that returns an empty (no-text) draft turn first — the
    // intermittent flash behavior — then a real draft on the retry.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const gate = tool({
      description: "Pause an assignment artifact for human approval.",
      inputSchema: z.object({ artifact: z.string().min(1) }),
      execute: async () => ({ parked: true }),
    })
    let draftCalls = 0
    const runner = new AISDKAgentRunner({
      runsDir: join(root, ".agent-runs"),
      tools: { assignment_gate: gate },
      toolApproval: { assignment_gate: "user-approval" },
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-empty-then-text",
        doGenerate: ({ prompt }) => {
          if (JSON.stringify(prompt).includes("Draft under review")) {
            return {
              content: [{ type: "text", text: "**Verified**\n- ok." }],
              finishReason: { unified: "stop" as const },
              usage: providerUsage,
            }
          }
          draftCalls += 1
          // First attempt: no text at all. Retry: a real draft.
          return draftCalls === 1
            ? { content: [], finishReason: { unified: "stop" as const }, usage: providerUsage }
            : {
                content: [{ type: "text", text: "# Memo\n\nRetried draft." }],
                finishReason: { unified: "stop" as const },
                usage: providerUsage,
              }
        },
      }),
    })
    try {
      const draft = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the empty first turn was retried, and the draft carries the retry's text.
      expect(draftCalls).toBe(2)
      expect(await readFile(draft.path, "utf8")).toContain("Retried draft.")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("approves a draft the model completed without parking at the gate", async () => {
    // Given: a runner whose draft emits its text and finishes (no gate tool call),
    // so the run is "completed", not "pending_approval" — how real models behave.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const gate = tool({
      description: "Pause an assignment artifact for human approval.",
      inputSchema: z.object({ artifact: z.string().min(1) }),
      execute: async () => ({ parked: true }),
    })
    const runner = new AISDKAgentRunner({
      runsDir: join(root, ".agent-runs"),
      tools: { assignment_gate: gate },
      toolApproval: { assignment_gate: "user-approval" },
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-no-park",
        doGenerate: () => ({
          content: [{ type: "text", text: "# Pricing Memo\n\nComplete draft." }],
          finishReason: { unified: "stop" as const },
          usage: providerUsage,
        }),
      }),
    })
    try {
      const draft = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })
      // The underlying run completed directly — the model never parked at the gate.
      expect((await runner.get(draft.runId)).status).toBe("completed")

      // When: the completed draft is approved.
      const final = await approveAssignment({
        vaultRoot: root,
        config: config(),
        runner,
        runId: draft.runId,
      })

      // Then: it is promoted to a final artifact rather than failing "not pending_approval".
      expect(final.path).toMatch(/final/)
      expect(await readFile(final.path, "utf8")).toContain("Complete draft.")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("creates a first pass without guidance, co-edits user changes and feedback, then approves v3", async () => {
    // Given: a course vault, an assignment, and a durable runner backed by a keyless model.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const runner = gatedRunner(join(root, ".agent-runs"))
    try {
      // When: the student drafts, hand-edits, revises twice, and approves the artifact.
      const first = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })
      const firstDocument = await readFile(first.path, "utf8")
      await writeFile(first.path, `${firstDocument}\nUSER_EDIT_TOKEN\n`, "utf8")
      const second = await reviseAssignment({
        vaultRoot: root,
        config: config(),
        runner,
        runId: first.runId,
        feedback: "FEEDBACK_TOKEN",
        index,
        triage: { summarize: async () => "unused" },
      })
      const third = await reviseAssignment({
        vaultRoot: root,
        config: config(),
        runner,
        runId: first.runId,
        feedback: "final pass",
        index,
        triage: { summarize: async () => "unused" },
      })
      const final = await approveAssignment({
        vaultRoot: root,
        config: config(),
        runner,
        runId: first.runId,
      })

      // Then: every version remains draft-gated, provenance is valid, and approval writes final only.
      expect(first.status).toBe("pending_approval")
      expect(second.path).toMatch(/\.v2\.md$/)
      expect(third.path).toMatch(/\.v3\.md$/)
      expect(parseAssignmentProvenance(await readFile(second.path, "utf8"))).toEqual(
        expect.objectContaining({ version: 2, source_files: expect.any(Array) }),
      )
      expect(await readFile(second.path, "utf8")).toContain("<!-- coedit-inputs-present -->")
      expect(await readFile(third.path, "utf8")).toContain("<!-- feedback-only-present -->")
      expect(await readFile(final.path, "utf8")).toContain("Third pass.")
      // And: every gated version carries the self-review correctness check.
      for (const path of [first.path, second.path, third.path, final.path]) {
        const content = await readFile(path, "utf8")
        expect(content).toContain("## Correctness check")
        expect(content).toContain("Every requirement is addressed.")
      }
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("prioritizes a file the assignment description links into the draft's source files", async () => {
    // Given: the assignment's own synced description links a Canvas file id,
    // and a synced vault file carries that same canvas_id in its frontmatter.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const paths = coursePaths(root, course.code, course.canvasId)
    await put(join(paths.assignments, "pricing-memo.md"), "See the case at /files/555 for details.")
    await mkdir(paths.files, { recursive: true })
    await writeFile(
      join(paths.files, "exampleco-case.md"),
      renderVaultDocument(
        createVaultFrontmatter({
          canvasId: "555",
          canvasUrl: "https://canvas.example.invalid/files/555",
          type: "file",
          content: "ExampleCo case body: pricing decision analysis.",
          source: "sync",
          status: "approved",
          aiPolicy: "allowed",
        }),
        "ExampleCo case body: pricing decision analysis.",
      ),
      "utf8",
    )
    const runner = gatedRunner(join(root, ".agent-runs"))
    try {
      // When: the draft is generated.
      const first = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the linked file's vault path is recorded among the draft's sources.
      const provenance = parseAssignmentProvenance(await readFile(first.path, "utf8"))
      expect(provenance.source_files).toContain("files/exampleco-case.md")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("banners an external exhibit-data link instead of letting the draft fabricate it", async () => {
    // Given: the assignment's own synced description references exhibit data
    // that lives behind an external hbsp.harvard.edu link, not in the vault.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const paths = coursePaths(root, course.code, course.canvasId)
    await put(
      join(paths.assignments, "pricing-memo.md"),
      'See the overhead exhibit at <a href="https://hbsp.harvard.edu/import/123456">Exhibit 3</a>.',
    )
    let captured = ""
    const gate = tool({
      description: "Pause an assignment artifact for human approval.",
      inputSchema: z.object({ artifact: z.string().optional() }),
      execute: async () => ({ parked: true }),
    })
    const runner = new AISDKAgentRunner({
      runsDir: join(root, ".agent-runs"),
      tools: { assignment_gate: gate },
      toolApproval: { assignment_gate: "user-approval" },
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-assignment",
        doGenerate: ({ prompt }) => {
          const serialized = JSON.stringify(prompt)
          if (serialized.includes("Draft under review")) {
            return {
              content: [{ type: "text", text: "**Verified**\n- Gaps are marked PENDING." }],
              finishReason: { unified: "stop" as const },
              usage: providerUsage,
            }
          }
          captured = serialized
          return {
            content: [
              {
                type: "text",
                text: [
                  "## Missing required sources",
                  "- Overhead exhibit data: https://hbsp.harvard.edu/import/123456",
                  "",
                  "Overhead allocation: PENDING — requires https://hbsp.harvard.edu/import/123456",
                ].join("\n"),
              },
              {
                type: "tool-call",
                toolCallId: "gate-1",
                toolName: "assignment_gate",
                input: JSON.stringify({ artifact: "draft" }),
              },
            ],
            finishReason: { unified: "tool-calls" },
            usage: providerUsage,
          }
        },
      }),
    })
    try {
      // When: the draft is generated for that assignment.
      const first = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the draft prompt carries the no-fabrication directive and lists
      // the external link under the "not available to you" heading.
      expect(captured).toContain("Do NOT invent or recall from memory")
      expect(captured).toContain("## Missing required sources")
      expect(captured).toContain("PENDING")
      expect(captured).toContain("Referenced sources NOT available to you")
      expect(captured).toContain("https://hbsp.harvard.edu/import/123456")
      // And: the gate still parks the bannered draft for approval as normal.
      expect(first.status).toBe("pending_approval")
      expect(await readFile(first.path, "utf8")).toContain("## Missing required sources")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  function promptCapturingRunner(
    runsDir: string,
    onDraft: (serializedPrompt: string) => string,
  ): AISDKAgentRunner {
    const gate = tool({
      description: "Pause an assignment artifact for human approval.",
      inputSchema: z.object({ artifact: z.string().optional() }),
      execute: async () => ({ parked: true }),
    })
    return new AISDKAgentRunner({
      runsDir,
      tools: { assignment_gate: gate },
      toolApproval: { assignment_gate: "user-approval" },
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-assignment",
        doGenerate: ({ prompt }) => {
          const serialized = JSON.stringify(prompt)
          if (serialized.includes("Draft under review")) {
            return {
              content: [{ type: "text", text: "**Verified**\n- ok." }],
              finishReason: { unified: "stop" as const },
              usage: providerUsage,
            }
          }
          return {
            content: [
              { type: "text", text: onDraft(serialized) },
              {
                type: "tool-call",
                toolCallId: "gate-1",
                toolName: "assignment_gate",
                input: JSON.stringify({ artifact: "draft" }),
              },
            ],
            finishReason: { unified: "tool-calls" },
            usage: providerUsage,
          }
        },
      }),
    })
  }

  it("carries a detected deliverable's items into the draft prompt", async () => {
    // Given: the assignment's own synced description carries a "Required:"
    // deliverable cue with two enumerated items.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const paths = coursePaths(root, course.code, course.canvasId)
    await put(
      join(paths.assignments, "pricing-memo.md"),
      "Required: 1. Compute the contribution margin. 2. Recommend a price point.",
    )
    let captured = ""
    const runner = promptCapturingRunner(join(root, ".agent-runs"), (serialized) => {
      captured = serialized
      return "# Pricing Memo\n\nDraft."
    })
    try {
      // When: the draft is generated.
      await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the prompt requires each detected item to be explicitly addressed.
      expect(captured).toContain("satisfy each required item below")
      expect(captured).toContain("### 1. Compute the contribution margin.")
      expect(captured).toContain("### 2. Recommend a price point.")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("scopes a detected deliverable to the PART the assignment description names", async () => {
    // Given: a linked case file with two parts, but the assignment's own
    // description tells the student to prepare only PART I.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const paths = coursePaths(root, course.code, course.canvasId)
    await put(
      join(paths.assignments, "pricing-memo.md"),
      "For this assignment you need to prepare PART I.",
    )
    await put(
      join(paths.modules, "01-pricing", "case.md"),
      "Required: PART I: Compute the payback period for the proposed plant expansion. " +
        "PART II: (a) Compute the discounted payback period. (b) Recommend whether to proceed.",
    )
    let captured = ""
    const runner = promptCapturingRunner(join(root, ".agent-runs"), (serialized) => {
      captured = serialized
      return "# Pricing Memo\n\nDraft."
    })
    try {
      // When: the draft is generated.
      await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the itemized checklist carries only PART I's requirement — PART
      // II's items never get their own "### <id>." heading (the raw case
      // text is still supplied as Materials, just not itemized as a task).
      expect(captured).toContain(
        "### PART I. Compute the payback period for the proposed plant expansion.",
      )
      expect(captured).not.toMatch(/###\s*PART II/)
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("suppresses an otherwise-detected deliverable when guidance declares '## Deliverable' / none", async () => {
    // Given: the assignment's own synced description carries a detectable
    // "Required:" cue, but the per-assignment guidance explicitly opts out
    // of auto-detection.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const paths = coursePaths(root, course.code, course.canvasId)
    await put(
      join(paths.assignments, "pricing-memo.md"),
      "Required: 1. Compute the contribution margin. 2. Recommend a price point.",
    )
    await put(
      join(paths.guidance, "pricing-memo-guidance.md"),
      ["# Assignment guidance", "Focus on the decision.", "## Deliverable", "none"].join("\n"),
    )
    let captured = ""
    const runner = promptCapturingRunner(join(root, ".agent-runs"), (serialized) => {
      captured = serialized
      return "# Pricing Memo\n\nDraft."
    })
    try {
      // When: the draft is generated.
      await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: no itemized deliverable checklist was injected, even though
      // detection would otherwise have found one.
      expect(captured).not.toContain("satisfy each required item below")
      expect(captured).not.toContain("### 1.")
      expect(captured).not.toContain("### 2.")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("non-regression: injects no deliverable block when nothing is detected and nothing is declared", async () => {
    // Given: the plain fixture vault — no detectable cue anywhere, and the
    // per-assignment guidance is the untouched default placeholder.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    let captured = ""
    const runner = promptCapturingRunner(join(root, ".agent-runs"), (serialized) => {
      captured = serialized
      return "# Pricing Memo\n\nDraft."
    })
    try {
      // When: the draft is generated.
      await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the prompt carries no injected deliverable checklist at all.
      expect(captured).not.toContain("satisfy each required item below")
      expect(captured).not.toContain("answer each discussion question below")
      expect(captured).not.toMatch(/###\s*\d+\./)
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("carries a detected deliverable's items into the revise prompt", async () => {
    // Given: an assignment description with a detectable "Required:" cue,
    // and an already-gated first draft.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const paths = coursePaths(root, course.code, course.canvasId)
    await put(
      join(paths.assignments, "pricing-memo.md"),
      "Required: 1. Compute the contribution margin. 2. Recommend a price point.",
    )
    let captured = ""
    const runner = promptCapturingRunner(join(root, ".agent-runs"), (serialized) => {
      captured = serialized
      return "# Pricing Memo\n\nDraft."
    })
    try {
      // When: the draft is generated, then revised.
      const first = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })
      await reviseAssignment({
        vaultRoot: root,
        config: config(),
        runner,
        runId: first.runId,
        feedback: "tighten the numbers",
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the revise prompt requires each detected item be re-addressed.
      expect(captured).toContain("satisfy each required item below")
      expect(captured).toContain("### 1. Compute the contribution margin.")
      expect(captured).toContain("### 2. Recommend a price point.")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("non-regression: injects no deliverable block into the revise prompt when nothing is detected or declared", async () => {
    // Given: the plain fixture vault — no detectable cue anywhere — and an
    // already-gated first draft.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    let captured = ""
    const runner = promptCapturingRunner(join(root, ".agent-runs"), (serialized) => {
      captured = serialized
      return "# Pricing Memo\n\nDraft."
    })
    try {
      // When: the draft is generated, then revised.
      const first = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })
      await reviseAssignment({
        vaultRoot: root,
        config: config(),
        runner,
        runId: first.runId,
        feedback: "tighten the numbers",
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the revise prompt carries no injected deliverable checklist.
      expect(captured).not.toContain("satisfy each required item below")
      expect(captured).not.toContain("answer each discussion question below")
      expect(captured).not.toMatch(/###\s*\d+\./)
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("logs discussion without writing a new draft version", async () => {
    // Given: an already-gated first draft and an independent discussion runner.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const draftRunner = gatedRunner(join(root, ".agent-runs"))
    const discussionRunner = new AISDKAgentRunner({
      runsDir: join(root, ".discuss-runs"),
      tools: {},
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-discuss",
        doGenerate: () => ({
          content: [{ type: "text", text: "Discussed the scope." }],
          finishReason: { unified: "stop" },
          usage: providerUsage,
        }),
      }),
    })
    try {
      const first = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner: draftRunner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // When: the student requests a discussion rather than a revision.
      const discussion = await discussAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner: discussionRunner,
        message: "What should I narrow?",
        triage: { summarize: async () => "unused" },
      })

      // Then: the conversation is durable but no .v2 artifact is created.
      expect(await readFile(discussion.path, "utf8")).toContain("Discussed the scope.")
      expect((await readdir(dirname(first.path))).filter((name) => name.includes(".v"))).toEqual([])
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("steers the draft structure from an assignment guidance structure declaration", async () => {
    // Given: the per-assignment guidance declares an explicit section structure.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const paths = coursePaths(root, course.code, course.canvasId)
    await put(
      join(paths.guidance, "pricing-memo-guidance.md"),
      [
        "# Assignment guidance",
        "Keep it crisp.",
        "## Brief structure",
        "Executive Summary",
        "Analysis",
        "Recommendation",
      ].join("\n"),
    )
    let captured = ""
    const gate = tool({
      description: "Pause an assignment artifact for human approval.",
      inputSchema: z.object({ artifact: z.string().optional() }),
      execute: async () => ({ parked: true }),
    })
    const runner = new AISDKAgentRunner({
      runsDir: join(root, ".agent-runs"),
      tools: { assignment_gate: gate },
      toolApproval: { assignment_gate: "user-approval" },
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-assignment",
        doGenerate: ({ prompt }) => {
          const serialized = JSON.stringify(prompt)
          if (serialized.includes("Draft under review")) {
            return {
              content: [{ type: "text", text: "**Verified**\n- Structure matches." }],
              finishReason: { unified: "stop" as const },
              usage: providerUsage,
            }
          }
          captured = serialized
          return {
            content: [
              { type: "text", text: "# Draft\n\nContent." },
              {
                type: "tool-call",
                toolCallId: "gate-1",
                toolName: "assignment_gate",
                input: JSON.stringify({ artifact: "draft" }),
              },
            ],
            finishReason: { unified: "tool-calls" },
            usage: providerUsage,
          }
        },
      }),
    })
    try {
      // When: the draft is generated from that customized guidance.
      const first = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the prompt steers the model toward the declared sections and the gate stays intact.
      expect(first.status).toBe("pending_approval")
      expect(captured).toContain("Executive Summary, Analysis, Recommendation")
      expect(captured).not.toContain("## Brief structure")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("completes the assignment and appends the self-review correctness check before the gate", async () => {
    // Given: a draft model that answers the assignment and a review model that flags uncertainty.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    let draftPromptSeen = ""
    let reviewPromptSeen = ""
    const gate = tool({
      description: "Pause an assignment artifact for human approval.",
      inputSchema: z.object({ artifact: z.string().optional() }),
      execute: async () => ({ parked: true }),
    })
    const runner = new AISDKAgentRunner({
      runsDir: join(root, ".agent-runs"),
      tools: { assignment_gate: gate },
      toolApproval: { assignment_gate: "user-approval" },
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-assignment",
        doGenerate: ({ prompt }) => {
          const serialized = JSON.stringify(prompt)
          if (serialized.includes("Draft under review")) {
            reviewPromptSeen = serialized
            return {
              content: [
                {
                  type: "text",
                  text: "**Verified**\n- The price recommendation matches the case data.\n\n**Needs verification**\n- The Q3 computation should be verified by running the script.",
                },
              ],
              finishReason: { unified: "stop" as const },
              usage: providerUsage,
            }
          }
          draftPromptSeen = serialized
          return {
            content: [
              {
                type: "text",
                text: "# Pricing Memo\n\nThe recommended price is $42 (contribution margin $18).",
              },
              {
                type: "tool-call",
                toolCallId: "gate-1",
                toolName: "assignment_gate",
                input: JSON.stringify({ artifact: "draft" }),
              },
            ],
            finishReason: { unified: "tool-calls" },
            usage: providerUsage,
          }
        },
      }),
    })
    try {
      // When: the assignment is drafted.
      const first = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the draft prompt demands the completed deliverable, not a guide.
      expect(draftPromptSeen).toContain("produce the actual deliverable")
      expect(draftPromptSeen).toContain("never deliver a guide")
      // And: the self-review re-read the produced draft against the source context.
      expect(reviewPromptSeen).toContain("The recommended price is $42")
      expect(reviewPromptSeen).toContain("## Materials")
      // And: the gated artifact is the complete draft plus the correctness check note.
      const content = await readFile(first.path, "utf8")
      expect(first.status).toBe("pending_approval")
      expect(content).toContain("The recommended price is $42 (contribution margin $18).")
      expect(content).toContain("## Correctness check")
      expect(content).toContain("The price recommendation matches the case data.")
      expect(content).toContain("should be verified by running the script")
      expect(content.indexOf("## Correctness check")).toBeGreaterThan(
        content.indexOf("The recommended price is $42"),
      )
      expect(parseAssignmentProvenance(content)).toEqual(
        expect.objectContaining({ version: 1, run_id: first.runId }),
      )
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("replaces a model-written correctness check with the fresh self-review note", async () => {
    // Given: a draft that already carries its own correctness-check section.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const gate = tool({
      description: "Pause an assignment artifact for human approval.",
      inputSchema: z.object({ artifact: z.string().optional() }),
      execute: async () => ({ parked: true }),
    })
    const runner = new AISDKAgentRunner({
      runsDir: join(root, ".agent-runs"),
      tools: { assignment_gate: gate },
      toolApproval: { assignment_gate: "user-approval" },
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-assignment",
        doGenerate: ({ prompt }) => {
          if (JSON.stringify(prompt).includes("Draft under review")) {
            return {
              content: [{ type: "text", text: "**Verified**\n- Fresh review note." }],
              finishReason: { unified: "stop" as const },
              usage: providerUsage,
            }
          }
          return {
            content: [
              {
                type: "text",
                text: "# Pricing Memo\n\nBody.\n\n## Correctness check\n\nStale model-written note.",
              },
              {
                type: "tool-call",
                toolCallId: "gate-1",
                toolName: "assignment_gate",
                input: JSON.stringify({ artifact: "draft" }),
              },
            ],
            finishReason: { unified: "tool-calls" },
            usage: providerUsage,
          }
        },
      }),
    })
    try {
      // When: the assignment is drafted.
      const first = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: exactly one correctness check remains — the fresh self-review note.
      const content = await readFile(first.path, "utf8")
      expect(content.match(/## Correctness check/g)).toHaveLength(1)
      expect(content).toContain("Fresh review note.")
      expect(content).not.toContain("Stale model-written note.")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses to draft and makes zero model calls when the monthly spend cap is already exceeded", async () => {
    // Given: a spend cap already met by prior month-to-date usage.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const cappedConfig: SchoolConfig = { ...config(), cost: { maxMonthlySpendUSD: 1 } }
    index.upsertTokenUsage({
      syncRunCanvasId: "prior-run",
      model: "mock/draft",
      functionName: "assignmentDraft",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      recordedAt: new Date().toISOString(),
      costUsd: 5,
    })
    let calls = 0
    const cappedRunner = new AISDKAgentRunner({
      runsDir: join(root, ".agent-runs-capped"),
      tools: {},
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-should-not-run",
        doGenerate: () => {
          calls += 1
          throw new Error("must not call the draft model when over the spend cap")
        },
      }),
    })
    try {
      // When: a draft is requested while over the cap.
      const attempt = draftAssignment({
        vaultRoot: root,
        config: cappedConfig,
        course,
        assignment,
        runner: cappedRunner,
        index,
        triage: {
          summarize: async () => {
            throw new Error("must not call the triage model when over the spend cap")
          },
        },
      })

      // Then: the preflight throws before any model call, and none was made.
      await expect(attempt).rejects.toBeInstanceOf(SpendCapExceededError)
      expect(calls).toBe(0)
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses to revise and makes zero model calls when the monthly spend cap is already exceeded", async () => {
    // Given: a spend cap already met by prior month-to-date usage. No draft need
    // exist — the preflight throws before `findDraft` even runs.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const cappedConfig: SchoolConfig = { ...config(), cost: { maxMonthlySpendUSD: 1 } }
    index.upsertTokenUsage({
      syncRunCanvasId: "prior-run",
      model: "mock/draft",
      functionName: "assignmentDraft",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      recordedAt: new Date().toISOString(),
      costUsd: 5,
    })
    let calls = 0
    const cappedRunner = new AISDKAgentRunner({
      runsDir: join(root, ".agent-runs-capped"),
      tools: {},
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-should-not-run",
        doGenerate: () => {
          calls += 1
          throw new Error("must not call the model when over the spend cap")
        },
      }),
    })
    try {
      // When: a revision is requested while over the cap.
      const attempt = reviseAssignment({
        vaultRoot: root,
        config: cappedConfig,
        runner: cappedRunner,
        runId: "nonexistent-run",
        feedback: "",
        index,
        triage: {
          summarize: async () => {
            throw new Error("must not call the triage model when over the spend cap")
          },
        },
      })

      // Then: the preflight throws before any model call (and before findDraft's lookup).
      await expect(attempt).rejects.toBeInstanceOf(SpendCapExceededError)
      expect(calls).toBe(0)
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("instructs Markdown tables (not ASCII/code fences) when the deliverable is computational", async () => {
    // Given: the assignment's own description carries a "Required:" cue, which
    // resolves to a `kind: "requirements"` (computational) deliverable.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const paths = coursePaths(root, course.code, course.canvasId)
    await put(
      join(paths.assignments, "pricing-memo.md"),
      "Required: 1. Prepare the T-accounts. 2. Recommend a price point.",
    )
    let captured = ""
    const runner = promptCapturingRunner(join(root, ".agent-runs"), (serialized) => {
      captured = serialized
      return "# Pricing Memo\n\nDraft."
    })
    try {
      // When: the draft is generated.
      await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the prompt tells the model to render tables as Markdown, never ASCII/code fences,
      // with one bare value per cell (no `$`, no bold, no index prefix mashed into a cell),
      // and — since extraction can no longer reliably guess a table's name from its cells —
      // requires a distinct heading immediately above every table naming what it is.
      expect(captured).toContain("GitHub-flavored Markdown table")
      expect(captured).toContain("Never render a table as ASCII art inside a code")
      expect(captured).toContain("put exactly ONE value per cell")
      expect(captured).toContain("no `**bold**` markers")
      expect(captured).toContain("Do not bold any cell's contents")
      expect(captured).toContain("Give EVERY table its own Markdown heading immediately above it")
      expect(captured).toContain("never group several tables under one shared heading")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not inject the tabular-output directive when no deliverable is detected", async () => {
    // Given: the plain fixture vault — no detectable "Required:"/questions cue anywhere.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    let captured = ""
    const runner = promptCapturingRunner(join(root, ".agent-runs"), (serialized) => {
      captured = serialized
      return "# Pricing Memo\n\nDraft."
    })
    try {
      // When: the draft is generated.
      await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the non-computational path never sees the tabular-output directive.
      expect(captured).not.toContain("GitHub-flavored Markdown table")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("writes a real .xlsx beside the draft when the model emits Markdown tables and Computations", async () => {
    // Given: a computational deliverable whose model output includes two
    // Markdown tables and a `## Computations` section (exactly the shape
    // `calculationDirective` + the new tabular-output directive require).
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const paths = coursePaths(root, course.code, course.canvasId)
    await put(
      join(paths.assignments, "pricing-memo.md"),
      "Required: 1. Prepare the Cash T-account.",
    )
    const draftBody = [
      "# Pricing Memo",
      "",
      "## Cash T-account",
      "",
      "| Debit | Credit |",
      "| --- | --- |",
      "| 100 | 50 |",
      "",
      "## Computations",
      "",
      "- ending cash — 50",
    ].join("\n")
    const runner = promptCapturingRunner(join(root, ".agent-runs"), () => draftBody)
    try {
      // When: the draft is generated and written.
      const result = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: a real, unzippable .xlsx sits right beside the written draft,
      // holding a "Cash T-account" sheet and a "Computations" sheet.
      const workbookPath = xlsxSiblingPath(result.path)
      const archive = await JSZip.loadAsync(await readFile(workbookPath))
      const workbookXml = await archive.file("xl/workbook.xml")?.async("text")
      expect(workbookXml).toContain('name="Cash T-account"')
      expect(workbookXml).toContain('name="Computations"')
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("writes no .xlsx when the draft has no tables and no Computations section", async () => {
    // Given: a draft that is plain prose only.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const runner = promptCapturingRunner(
      join(root, ".agent-runs"),
      () => "# Pricing Memo\n\nJust a prose recommendation, no tables or computations.",
    )
    try {
      // When: the draft is generated and written.
      const result = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: no workbook is written for it.
      await expect(readFile(xlsxSiblingPath(result.path))).rejects.toThrow()
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("assignment engine — calculate-tool computation verification", () => {
  it("directs the draft prompt to compute every derived number with the calculate tool", async () => {
    // Given: a draft runner wired with the real calculate tool alongside the gate.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    let draftPromptSeen = ""
    const gate = tool({
      description: "Pause an assignment artifact for human approval.",
      inputSchema: z.object({ artifact: z.string().optional() }),
      execute: async () => ({ parked: true }),
    })
    const runner = new AISDKAgentRunner({
      runsDir: join(root, ".agent-runs"),
      tools: { assignment_gate: gate, calculate: calculateTool },
      toolApproval: { assignment_gate: "user-approval" },
      stopWhen: stepCountIs(10),
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-assignment",
        doGenerate: ({ prompt }) => {
          const serialized = JSON.stringify(prompt)
          if (serialized.includes("Draft under review")) {
            return {
              content: [{ type: "text", text: "**Verified**\n- ok." }],
              finishReason: { unified: "stop" as const },
              usage: providerUsage,
            }
          }
          draftPromptSeen = serialized
          return {
            content: [
              { type: "text", text: "# Pricing Memo\n\nDone." },
              {
                type: "tool-call",
                toolCallId: "gate-1",
                toolName: "assignment_gate",
                input: JSON.stringify({ artifact: "draft" }),
              },
            ],
            finishReason: { unified: "tool-calls" },
            usage: providerUsage,
          }
        },
      }),
    })
    try {
      // When: the assignment is drafted.
      await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the draft prompt demands calculate-tool use for every derived number,
      // tells the model to BATCH computations into few calls (not one per number), and —
      // independently of that batching — requires the `## Computations` section to unroll
      // every value from a batched call onto its own `label — value` line (never one line
      // summarizing/listing several values together, the defect a live batched call produced).
      expect(draftPromptSeen).toContain("MUST be produced by the `calculate` tool")
      expect(draftPromptSeen).toContain("BATCH your work")
      expect(draftPromptSeen).toContain("## Computations")
      expect(draftPromptSeen).toContain("UNROLLS every")
      expect(draftPromptSeen).toContain(
        "never one line summarizing or listing several values together",
      )
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("carries calculate tool calls from the draft run into the review prompt as a computation log", async () => {
    // Given: a model that computes a margin via `calculate` before completing the gated draft.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    let reviewPromptSeen = ""
    let modelCalls = 0
    const gate = tool({
      description: "Pause an assignment artifact for human approval.",
      inputSchema: z.object({ artifact: z.string().optional() }),
      execute: async () => ({ parked: true }),
    })
    const runner = new AISDKAgentRunner({
      runsDir: join(root, ".agent-runs"),
      tools: { assignment_gate: gate, calculate: calculateTool },
      toolApproval: { assignment_gate: "user-approval" },
      stopWhen: stepCountIs(10),
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-assignment",
        doGenerate: ({ prompt }) => {
          const serialized = JSON.stringify(prompt)
          if (serialized.includes("Draft under review")) {
            reviewPromptSeen = serialized
            return {
              content: [{ type: "text", text: "**Verified**\n- Matches the computation log." }],
              finishReason: { unified: "stop" as const },
              usage: providerUsage,
            }
          }
          modelCalls += 1
          if (modelCalls === 1) {
            return {
              content: [
                {
                  type: "tool-call",
                  toolCallId: "calc-1",
                  toolName: "calculate",
                  input: JSON.stringify({ label: "gross margin %", code: "(120 - 72) / 120" }),
                },
              ],
              finishReason: { unified: "tool-calls" },
              usage: providerUsage,
            }
          }
          return {
            content: [
              {
                type: "text",
                text: "# Pricing Memo\n\nMargin is 40%.\n\n## Computations\n- gross margin % — 0.4",
              },
              {
                type: "tool-call",
                toolCallId: "gate-1",
                toolName: "assignment_gate",
                input: JSON.stringify({ artifact: "draft" }),
              },
            ],
            finishReason: { unified: "tool-calls" },
            usage: providerUsage,
          }
        },
      }),
    })
    try {
      // When: the assignment is drafted.
      const first = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the review prompt carries the actual executed computation, not a re-derivation ask.
      expect(reviewPromptSeen).toContain("## Computation log")
      expect(reviewPromptSeen).toContain("gross margin %")
      expect(reviewPromptSeen).toContain("(120 - 72) / 120")
      expect(reviewPromptSeen).toContain("0.4")
      expect(reviewPromptSeen).toContain("Do not recompute or re-derive")
      expect(first.status).toBe("pending_approval")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("still reviews and writes a draft that made no calculate calls, flagging the log as empty", async () => {
    // Given: a draft run that never calls `calculate` (only text + gate).
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const runner = gatedRunner(join(root, ".agent-runs"))
    try {
      // When: the assignment is drafted with the plain gated runner (no calculate tool).
      const first = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the draft still writes successfully with its correctness check.
      const content = await readFile(first.path, "utf8")
      expect(first.status).toBe("pending_approval")
      expect(content).toContain("## Correctness check")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("degrades the correctness check to an explicit unverified note when the review call fails", async () => {
    // Given: a draft model that succeeds, but whose review call throws.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    const gate = tool({
      description: "Pause an assignment artifact for human approval.",
      inputSchema: z.object({ artifact: z.string().optional() }),
      execute: async () => ({ parked: true }),
    })
    const runner = new AISDKAgentRunner({
      runsDir: join(root, ".agent-runs"),
      tools: { assignment_gate: gate },
      toolApproval: { assignment_gate: "user-approval" },
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-assignment",
        doGenerate: ({ prompt }) => {
          if (JSON.stringify(prompt).includes("Draft under review")) {
            throw new Error("model unavailable")
          }
          return {
            content: [
              { type: "text", text: "# Pricing Memo\n\nDone." },
              {
                type: "tool-call",
                toolCallId: "gate-1",
                toolName: "assignment_gate",
                input: JSON.stringify({ artifact: "draft" }),
              },
            ],
            finishReason: { unified: "tool-calls" },
            usage: providerUsage,
          }
        },
      }),
    })
    try {
      // When: the assignment is drafted despite the review call failing.
      const first = await draftAssignment({
        vaultRoot: root,
        config: config(),
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "unused" },
      })

      // Then: the draft is still written and gated; the check degrades honestly, never blocks.
      const content = await readFile(first.path, "utf8")
      expect(first.status).toBe("pending_approval")
      expect(content).toContain("## Correctness check")
      expect(content).toContain("did not return a result")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
