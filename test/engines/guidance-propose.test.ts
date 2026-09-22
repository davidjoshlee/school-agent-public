import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { MockLanguageModelV4 } from "ai/test"
import { describe, expect, it } from "vitest"

import { AISDKAgentRunner } from "../../src/agents/runner.js"
import type { SchoolConfig } from "../../src/config/index.js"
import { parseStructure } from "../../src/engines/guidance.js"
import { proposeGuidance } from "../../src/engines/guidance-propose.js"
import { createSchoolIndex } from "../../src/store/db.js"
import { coursePaths } from "../../src/store/paths.js"
import {
  createVaultFrontmatter,
  parseVaultDocument,
  renderVaultDocument,
} from "../../src/store/vault-document.js"
import { realSchoolModels, schoolConfig } from "../helpers/schoolConfig.js"
import { temporaryDirectory } from "../helpers/tempDir.js"

const course = {
  code: "STRAT 101",
  canvasId: "course-17",
  canvasUrl: "https://canvas.example.invalid/courses/course-17",
  aiPolicy: "allowed" as const,
} as const

const usage = { inputTokens: 10, outputTokens: 5 } as const
const providerUsage = {
  inputTokens: {
    total: usage.inputTokens,
    noCache: usage.inputTokens,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: usage.outputTokens, text: usage.outputTokens, reasoning: undefined },
} as const

function config(): SchoolConfig {
  return schoolConfig({
    vaultPath: "unused",
    indexPath: ":memory:",
    pilotCourseId: null,
    canvas: { baseUrl: "https://canvas.example.invalid" },
    models: realSchoolModels,
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
  const root = await temporaryDirectory("school-agent-guidance-propose-")
  const paths = coursePaths(root, course.code, course.canvasId)
  await put(
    paths.syllabus,
    "This is a case-method strategy class. Come prepared with your recommendation.",
  )
  await put(
    join(paths.assignments, "case-1.md"),
    "Case 1: Pricing under uncertainty. Required: 1. State the recommendation. 2. Justify with numbers.",
  )
  await put(
    join(paths.assignments, "case-1.feedback.md"),
    "Score: 4/5. Strong on numbers, but the recommendation needs to be stated up front, not buried.",
  )
  return root
}

async function fixtureVaultWithMajorDeliverable(): Promise<string> {
  const root = await temporaryDirectory("school-agent-guidance-propose-deliverable-")
  const paths = coursePaths(root, course.code, course.canvasId)
  await put(
    paths.syllabus,
    "A non-market strategy class. The term project is a CEO memo on a live policy fight.",
  )
  await put(
    join(paths.assignments, "ceo-memo-project.md"),
    [
      "Required: write a memo to the CEO with the following sections:",
      "Non-Market Issue, Firm and Industry Context, Stakeholder and Institutional Analysis (the 4 I's),",
      "Strategic Alternatives, Pivotal Politics Analysis, Recommendation, Implementation and Feasibility,",
      "Risk and Competitor Response.",
    ].join(" "),
  )
  await put(
    join(paths.assignments, "ceo-memo-project.feedback.md"),
    "Score: 4/5. Give an explicit probability of changing the status quo and address competitor response directly.",
  )
  return root
}

const proposalText = [
  "This class wants the recommendation stated up front, then justified with the numbers.",
  "## Brief structure",
  "Facts",
  "Analysis",
  "Recommendation",
].join("\n")

function runner(runsDir: string, text: string): AISDKAgentRunner {
  return new AISDKAgentRunner({
    runsDir,
    tools: {},
    model: new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock-guidance-propose",
      doGenerate: () => ({
        content: [{ type: "text", text }],
        finishReason: { unified: "stop" },
        usage: providerUsage,
      }),
    }),
  })
}

function capturingRunner(
  runsDir: string,
  text: string,
  onPrompt: (prompt: string) => void,
): AISDKAgentRunner {
  return new AISDKAgentRunner({
    runsDir,
    tools: {},
    model: new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock-guidance-propose-capture",
      doGenerate: ({ prompt }) => {
        onPrompt(JSON.stringify(prompt))
        return {
          content: [{ type: "text", text }],
          finishReason: { unified: "stop" },
          usage: providerUsage,
        }
      },
    }),
  })
}

describe("proposeGuidance", () => {
  it("never touches an existing user-owned prep-guidance.md, writing only the .proposed.md sibling", async () => {
    // Given: a real, user-authored prep-guidance.md already in place.
    const root = await fixtureVault()
    const paths = coursePaths(root, course.code, course.canvasId)
    const userGuidancePath = join(paths.guidance, "prep-guidance.md")
    const userGuidanceRaw = document("Answer every question directly; never pad with summary.")
    await mkdir(dirname(userGuidancePath), { recursive: true })
    await writeFile(userGuidancePath, userGuidanceRaw, "utf8")
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      // When: a proposal is generated for the course.
      const result = await proposeGuidance({
        vaultRoot: root,
        config: config(),
        course,
        index,
        runner: runner(join(root, ".agent-runs"), proposalText),
      })

      // Then: the user's file is byte-identical, and only the .proposed.md sibling was written.
      expect(await readFile(userGuidancePath, "utf8")).toBe(userGuidanceRaw)
      expect(result.path).toBe(paths.guidanceProposal)
      expect(result.path).not.toBe(userGuidancePath)
      expect(await readFile(result.path, "utf8")).toContain("## Brief structure")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("writes a proposal even when no prep-guidance.md exists yet", async () => {
    // Given: a course with no guidance directory at all.
    const root = await fixtureVault()
    const paths = coursePaths(root, course.code, course.canvasId)
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      // When: a proposal is generated.
      const result = await proposeGuidance({
        vaultRoot: root,
        config: config(),
        course,
        index,
        runner: runner(join(root, ".agent-runs"), proposalText),
      })

      // Then: the proposal path is written and no prep-guidance.md was created.
      expect(result.path).toBe(paths.guidanceProposal)
      await expect(readFile(join(paths.guidance, "prep-guidance.md"), "utf8")).rejects.toThrow()
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("round-trips the declared sections through parseStructure exactly", async () => {
    // Given: a proposal declaring three sections.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      // When: the proposal is generated and written.
      const result = await proposeGuidance({
        vaultRoot: root,
        config: config(),
        course,
        index,
        runner: runner(join(root, ".agent-runs"), proposalText),
      })

      // Then: parsing the written body back through parseStructure yields exactly those sections.
      const written = parseVaultDocument(await readFile(result.path, "utf8"), result.path)
      const structure = parseStructure(written.content)
      expect(structure.sections).toEqual(["Facts", "Analysis", "Recommendation"])
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("writes a valid vault document with type guidance and source agent", async () => {
    // Given: a course fixture.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      // When: the proposal is generated.
      const result = await proposeGuidance({
        vaultRoot: root,
        config: config(),
        course,
        index,
        runner: runner(join(root, ".agent-runs"), proposalText),
      })

      // Then: it parses as a valid vault document with the expected frontmatter.
      const written = parseVaultDocument(await readFile(result.path, "utf8"), result.path)
      expect(written.frontmatter.type).toBe("guidance")
      expect(written.frontmatter.source).toBe("agent")
      expect(written.frontmatter.status).toBe("draft")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses to write a proposal whose sections don't round-trip", async () => {
    // Given: a model that returns no '## Brief structure' declaration at all.
    const root = await fixtureVault()
    const paths = coursePaths(root, course.code, course.canvasId)
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      // When: generation is attempted.
      const attempt = proposeGuidance({
        vaultRoot: root,
        config: config(),
        course,
        index,
        runner: runner(
          join(root, ".agent-runs"),
          "Just some free-form prose with no structure block.",
        ),
      })

      // Then: it is rejected, and nothing is written.
      await expect(attempt).rejects.toThrow(/Brief structure/)
      await expect(readFile(paths.guidanceProposal, "utf8")).rejects.toThrow()
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("re-running is safe and does not duplicate or corrupt the proposal", async () => {
    // Given: a course fixture and a deterministic model.
    const root = await fixtureVault()
    const paths = coursePaths(root, course.code, course.canvasId)
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      // When: propose runs twice in a row with the same output.
      await proposeGuidance({
        vaultRoot: root,
        config: config(),
        course,
        index,
        runner: runner(join(root, ".agent-runs"), proposalText),
      })
      const secondResult = await proposeGuidance({
        vaultRoot: root,
        config: config(),
        course,
        index,
        runner: runner(join(root, ".agent-runs-2"), proposalText),
      })

      // Then: the same single file exists with identical content, no versioned sibling.
      expect(secondResult.path).toBe(paths.guidanceProposal)
      const content = await readFile(paths.guidanceProposal, "utf8")
      expect(content).toContain("## Brief structure")
      await expect(readFile(`${paths.guidanceProposal}.v2`, "utf8")).rejects.toThrow()
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("resolves the course by Canvas id and by course code through the CLI's index lookup pattern", async () => {
    // Given: an index seeded with the fixture course.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      index.upsertCourse({
        canvasId: course.canvasId,
        courseCode: course.code,
        name: "Strategy",
        workflowState: "available",
      })

      // Then: both id and code resolve to the same course row (the lookup the CLI performs).
      expect(index.courseByCanvasId(course.canvasId)?.courseCode).toBe(course.code)
      expect(index.courseByCode(course.code)?.canvasId).toBe(course.canvasId)
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("frames '## Brief structure' as the weekly prep brief even when materials are dominated by a major graded deliverable", async () => {
    // Given: a course whose only sampled assignment is a big CEO-memo-shaped
    // term project, the exact scenario that produced a deliverable-shaped
    // (wrong) structure live.
    const root = await fixtureVaultWithMajorDeliverable()
    const index = createSchoolIndex({ path: ":memory:" })
    let captured = ""
    try {
      // When: a proposal is generated.
      await proposeGuidance({
        vaultRoot: root,
        config: config(),
        course,
        index,
        runner: capturingRunner(join(root, ".agent-runs"), proposalText, (prompt) => {
          captured = prompt
        }),
      })

      // Then: the prompt explicitly tells the model '## Brief structure' governs
      // the weekly prep brief, contrasts it against deliverable/memo shapes, and
      // routes the deliverable's own structure into the free-form prose instead.
      expect(captured).toContain("WEEKLY PREP BRIEF")
      expect(captured).toContain("It is NEVER the shape of a graded submission")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reads an existing declared '## Brief structure' as a baseline into the prompt without ever writing to the user's file", async () => {
    // Given: the user's own prep-guidance.md already declares a prep-shaped structure.
    const root = await fixtureVault()
    const paths = coursePaths(root, course.code, course.canvasId)
    const userGuidancePath = join(paths.guidance, "prep-guidance.md")
    const userGuidanceRaw = document(
      ["## Brief structure", "Key Concepts", "Reading Takeaways", "Discussion Prep"].join("\n"),
    )
    await mkdir(dirname(userGuidancePath), { recursive: true })
    await writeFile(userGuidancePath, userGuidanceRaw, "utf8")
    const index = createSchoolIndex({ path: ":memory:" })
    let captured = ""
    try {
      // When: a proposal is generated for the same course.
      await proposeGuidance({
        vaultRoot: root,
        config: config(),
        course,
        index,
        runner: capturingRunner(join(root, ".agent-runs"), proposalText, (prompt) => {
          captured = prompt
        }),
      })

      // Then: the declared baseline sections reach the prompt as the starting point...
      expect(captured).toContain("Key Concepts, Reading Takeaways, Discussion Prep")
      expect(captured).toContain("starting point")
      // ...and the user's file was only ever read, never modified.
      expect(await readFile(userGuidancePath, "utf8")).toBe(userGuidanceRaw)
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
