import { createHash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { MockLanguageModelV4 } from "ai/test"
import { describe, expect, it } from "vitest"

import { AISDKAgentRunner } from "../src/agents/runner.js"
import type { SchoolConfig } from "../src/config/index.js"
import {
  generatePrepBrief,
  PrepContentError,
  PrepGenerationError,
  prepPeriodPlacement,
} from "../src/engines/prep.js"
import { SpendCapExceededError } from "../src/models/cost.js"
import { createSchoolIndex } from "../src/store/db.js"
import { coursePaths } from "../src/store/paths.js"
import { renderVaultDocument } from "../src/store/vault.js"
import { parseVaultDocument, type VaultFrontmatter } from "../src/store/vault-document.js"
import { realSchoolModels, schoolConfig } from "./helpers/schoolConfig.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

const course = {
  code: "STRAT 101",
  canvasId: "course-17",
  canvasUrl: "https://canvas.example.invalid/courses/course-17",
  aiPolicy: "allowed" as const,
} as const
/** Expected flat usage numbers surfaced through {@link AgentRunResult.usage}. */
const usage = { inputTokens: 10, outputTokens: 5 } as const
/**
 * The real `LanguageModelV4Usage` wire shape a provider's `doGenerate`
 * returns: nested `{ total, ... }` objects, not flat numbers. A flat
 * `{ inputTokens: number }` silently fails schema validation and every
 * count comes back `undefined`, so the runner's usage degrades to `null`
 * unnoticed and prep falls back to `estimateTokens`.
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

function config(granularity: "week" | "session" = "week"): SchoolConfig {
  return schoolConfig({
    vaultPath: "unused",
    indexPath: ":memory:",
    pilotCourseId: null,
    canvas: { baseUrl: "https://canvas.example.invalid" },
    models: realSchoolModels,
    prep: { granularity },
  })
}

function document(content: string, dates: VaultFrontmatter["dates"] = {}): string {
  const frontmatter: VaultFrontmatter = {
    canvas_id: "fixture",
    canvas_url: "https://canvas.example.invalid/resource",
    type: "fixture",
    dates,
    content_hash: createHash("sha256").update(content).digest("hex"),
    source: "sync",
    status: "approved",
    ai_policy: "allowed",
    redistribution: "allowed",
  }
  return renderVaultDocument(frontmatter, content)
}

async function put(
  path: string,
  content: string,
  dates: VaultFrontmatter["dates"] = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, document(content, dates), "utf8")
}

async function fixtureVault(syllabus = "Week 1: Pricing under uncertainty."): Promise<string> {
  const root = await temporaryDirectory("school-agent-prep-")
  const paths = coursePaths(root, course.code, course.canvasId)
  await put(paths.syllabus, syllabus)
  await put(paths.playbook, "Instructor rewards quantified trade-offs.")
  await put(join(paths.guidance, "prep-guidance.md"), "Focus on the decision and its risks.")
  await put(
    join(paths.modules, "01-pricing", "pricing-case.md"),
    "Week 1 agenda: price the new product using contribution margin. The case describes marginal revenue, marginal cost, rival price cuts, and price-sensitive buyers across distinct routes.",
  )
  const week = join(paths.root, "Week 01 - Sep 08")
  await put(join(week, "Module.md"), "Week 1: Pricing\n- Page: Pricing Case", {
    unlock_at: "2026-09-08T00:00:00.000Z",
  })
  await put(
    join(week, "pricing-case.md"),
    "Week 1 agenda: price the new product using contribution margin.",
  )
  await put(
    paths.index,
    [
      "| title | type | dates | path | token estimate |",
      "| --- | --- | --- | --- | --- |",
      "| Pricing case | module | 2026-09-08 | Week 01 - Sep 08/pricing-case.md | 30 |",
    ].join("\n"),
  )
  return root
}

function runner(runsDir: string, text: string): AISDKAgentRunner {
  return new AISDKAgentRunner({
    runsDir,
    tools: {},
    model: new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock-prep",
      doGenerate: () => ({
        content: [{ type: "text", text }],
        finishReason: { unified: "stop" },
        usage: providerUsage,
      }),
    }),
  })
}

const brief = [
  "## Agenda",
  "- Price the new product.",
  "## Readings",
  "- [Pricing case](Week 01 - Sep 08/pricing-case.md)",
  "## Concepts",
  "- Contribution margin",
  "## Assignments Due",
  "- None posted",
  "## Prep Checklist",
  "- Calculate the margin before class.",
].join("\n")

describe("generatePrepBrief", () => {
  it("places prep in the selected v2 week directory", () => {
    expect(
      prepPeriodPlacement({
        mode: "module",
        paths: [
          "Week 01 - Sep 21/Other/Session 1 - Example Consulting.md",
          "Week 01 - Sep 21/Other/DEMO Case Brief.pdf.md",
        ],
        moduleCanvasIds: ["module-1"],
        moduleTitles: ["Session 1: Example Consulting"],
      }),
    ).toEqual({ kind: "week", number: 1, title: "Sep 21" })
  })

  it("writes an auto-final weekly brief with only vault-backed reading links and records prep usage", async () => {
    // Given: a fixture course with posted material and a deterministic, keyless AI SDK model.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      // When: the prep engine creates a weekly brief using the AgentRunner seam.
      const result = await generatePrepBrief({
        vaultRoot: root,
        config: config(),
        course,
        period: { kind: "week", value: "2026-09-08" },
        index,
        runner: runner(join(root, ".agent-runs"), brief),
        triage: { summarize: async () => "unused" },
      })

      // Then: every required section is auto-delivered and its reading resolves in the course vault.
      const output = parseVaultDocument(await readFile(result.path, "utf8"), result.path)
      expect(output.frontmatter.status).toBe("auto-final")
      expect(output.content).toContain("## Agenda")
      expect(output.content).toContain("## Readings")
      expect(output.content).toContain("## Concepts")
      expect(output.content).toContain("## Assignments Due")
      expect(output.content).toContain("## Prep Checklist")
      await expect(
        readFile(
          join(
            coursePaths(root, course.code, course.canvasId).root,
            "Week 01 - Sep 08/pricing-case.md",
          ),
          "utf8",
        ),
      ).resolves.toContain("contribution margin")
      expect(index.tokenUsageForFunction("prepBrief")).toMatchObject({
        functionName: "prepBrief",
        model: "anthropic/claude-3-7-sonnet",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("records real token usage and a non-zero computed cost for a priced model", async () => {
    // Given: a fixture course and a prepBrief model that IS priced in
    // config/model-prices.default.json (unlike the realSchoolModels default,
    // which asserts against an unpriced provider elsewhere in this file).
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      const pricedConfig = {
        ...config(),
        models: {
          ...config().models,
          functions: {
            ...config().models.functions,
            prepBrief: "google/gemini-3.7-flash",
          },
        },
      }

      // When: the prep engine runs against the mocked model's real usage.
      await generatePrepBrief({
        vaultRoot: root,
        config: pricedConfig,
        course,
        period: { kind: "week", value: "2026-09-08" },
        index,
        runner: runner(join(root, ".agent-runs"), brief),
        triage: { summarize: async () => "unused" },
      })

      // Then: the logged row carries the mock model's real token counts and a
      // cost computed from the placeholder price table, never a hardcoded 0.
      expect(index.tokenUsageForFunction("prepBrief")).toMatchObject({
        model: "google/gemini-3.7-flash",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
      const logged = index.tokenUsageForFunction("prepBrief")
      expect(logged?.costUsd).toBeGreaterThan(0)
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does the prep: the prompt demands synthesis and the brief delivers the distilled substance", async () => {
    // Given: a fixture course with a reading and a prompt-capturing model.
    const root = await fixtureVault()
    let captured = ""
    const synthesizedBrief = [
      "## Agenda",
      "- Price the new product.",
      "## Readings",
      "- [Pricing case](Week 01 - Sep 08/pricing-case.md)",
      "## Concepts",
      "- Contribution margin is price minus variable cost; the case uses it as the price floor.",
      "## Assignments Due",
      "- None posted",
      "## Prep Checklist",
      "- Calculate the margin before class.",
    ].join("\n")
    const capturingRunner = new AISDKAgentRunner({
      runsDir: join(root, ".agent-runs"),
      tools: {},
      model: new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-prep",
        doGenerate: ({ prompt }) => {
          captured = JSON.stringify(prompt)
          return {
            content: [{ type: "text", text: synthesizedBrief }],
            finishReason: { unified: "stop" },
            usage: providerUsage,
          }
        },
      }),
    })
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      // When: the prep brief is generated.
      const result = await generatePrepBrief({
        vaultRoot: root,
        config: config(),
        course,
        period: { kind: "week", value: "2026-09-08" },
        index,
        runner: capturingRunner,
        triage: { summarize: async () => "unused" },
      })

      // Then: the prompt orders the done work (read + synthesize), not a plan.
      expect(captured).toContain("read the supplied readings")
      expect(captured).toContain("FINISHED prep")
      expect(captured).toContain("not a plan")
      expect(captured).toContain("key concepts actually synthesized")
      // And: the delivered brief carries the distilled substance, not a pointer to the reading.
      const output = parseVaultDocument(await readFile(result.path, "utf8"), result.path)
      expect(output.content).toContain(
        "Contribution margin is price minus variable cost; the case uses it as the price floor.",
      )
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("drives the brief structure from a prep-guidance structure declaration", async () => {
    // Given: the course's prep-guidance declares a custom section structure.
    const root = await fixtureVault()
    const paths = coursePaths(root, course.code, course.canvasId)
    await put(
      join(paths.guidance, "prep-guidance.md"),
      [
        "Quantify the trade-offs.",
        "## Brief structure",
        "Agenda",
        "Required Readings",
        "Key Takeaway",
      ].join("\n"),
    )
    const customBrief = [
      "## Agenda",
      "- Price the new product.",
      "## Required Readings",
      "- [Pricing case](Week 01 - Sep 08/pricing-case.md)",
      "## Key Takeaway",
      "- Contribution margin drives the price.",
    ].join("\n")
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      // When: a brief is generated with the customized guidance in place.
      const result = await generatePrepBrief({
        vaultRoot: root,
        config: config(),
        course,
        period: { kind: "week", value: "2026-09-08" },
        index,
        runner: runner(join(root, ".agent-runs"), customBrief),
        triage: { summarize: async () => "unused" },
      })

      // Then: the brief carries exactly the declared sections, not the defaults.
      const output = parseVaultDocument(await readFile(result.path, "utf8"), result.path)
      expect(output.content).toContain("## Agenda")
      expect(output.content).toContain("## Required Readings")
      expect(output.content).toContain("## Key Takeaway")
      expect(output.content).not.toContain("## Concepts")
      expect(output.content).not.toContain("## Prep Checklist")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("falls back to the default sections when prep-guidance declares no structure", async () => {
    // Given: a guidance file with only a free-form note and no structure declaration.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      // When: a brief is generated from that untouched guidance.
      const result = await generatePrepBrief({
        vaultRoot: root,
        config: config(),
        course,
        period: { kind: "week", value: "2026-09-08" },
        index,
        runner: runner(join(root, ".agent-runs"), brief),
        triage: { summarize: async () => "unused" },
      })

      // Then: the historical default five sections are produced.
      const output = parseVaultDocument(await readFile(result.path, "utf8"), result.path)
      for (const section of [
        "Agenda",
        "Readings",
        "Concepts",
        "Assignments Due",
        "Prep Checklist",
      ]) {
        expect(output.content).toContain(`## ${section}`)
      }
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects a fabricated reading link even under a custom structure", async () => {
    // Given: a customized structure whose brief cites a path not in the vault.
    const root = await fixtureVault()
    const paths = coursePaths(root, course.code, course.canvasId)
    await put(
      join(paths.guidance, "prep-guidance.md"),
      [
        "Quantify the trade-offs.",
        "## Brief structure",
        "Agenda",
        "Required Readings",
        "Key Takeaway",
      ].join("\n"),
    )
    const fabricatedBrief = [
      "## Agenda",
      "- Price the new product.",
      "## Required Readings",
      "- [Fabricated](modules/01-pricing/not-posted.md)",
      "## Key Takeaway",
      "- Contribution margin.",
    ].join("\n")
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      // When: generation returns a brief citing a path that was never supplied.
      const attempt = generatePrepBrief({
        vaultRoot: root,
        config: config(),
        course,
        period: { kind: "week", value: "2026-09-08" },
        index,
        runner: runner(join(root, ".agent-runs"), fabricatedBrief),
        triage: { summarize: async () => "unused" },
      })

      // Then: the fabrication guard rejects it as unsafe to deliver.
      await expect(attempt).rejects.toThrow("citation does not resolve to supplied vault context")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("fails before generation when an explicitly requested session has no matching module", async () => {
    // Given: session-level prep is configured, but the vault has no matching session module.
    const root = await fixtureVault("Course overview without a meeting schedule.")
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      let called = false
      const attempt = generatePrepBrief({
        vaultRoot: root,
        config: config("session"),
        course,
        period: { kind: "session", value: "2" },
        modelOverride: "openai/gpt-4.1-mini",
        index,
        runner: {
          run: async () => {
            called = true
            throw new Error("must not run")
          },
        } as never,
        triage: { summarize: async () => "unused" },
      })

      // Then: it reports the mismatch without generation or an Other/Prep write.
      await expect(attempt).rejects.toThrow("No matching Week/Milestone module")
      expect(called).toBe(false)
      await expect(
        readFile(
          join(
            coursePaths(root, course.code, course.canvasId).root,
            "Other",
            "Prep",
            "Session 2.md",
          ),
          "utf8",
        ),
      ).rejects.toThrow()
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports no posted materials and wraps model failures with retry guidance", async () => {
    // Given: an empty manifest, then a model transport failure for an otherwise valid course.
    const root = await fixtureVault()
    const paths = coursePaths(root, course.code, course.canvasId)
    await rm(join(paths.root, "Week 01 - Sep 08", "Module.md"))
    await rm(join(paths.root, "Week 01 - Sep 08", "pricing-case.md"))
    await put(
      paths.index,
      "| title | type | dates | path | token estimate |\n| --- | --- | --- | --- | --- |",
    )
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      // When: generation receives no posted material.
      const noMaterials = generatePrepBrief({
        vaultRoot: root,
        config: config(),
        course,
        period: { kind: "week", value: "2026-09-08" },
        index,
        runner: runner(join(root, ".agent-runs"), brief),
        triage: { summarize: async () => "unused" },
      })

      // Then: an explicit period without a module match fails safely.
      await expect(noMaterials).rejects.toThrow("No matching Week/Milestone module")

      await put(
        paths.index,
        [
          "| title | type | dates | path | token estimate |",
          "| --- | --- | --- | --- | --- |",
          "| Pricing case | module | 2026-09-08 | Week 01 - Sep 08/pricing-case.md | 30 |",
        ].join("\n"),
      )
      await put(
        join(paths.root, "Week 01 - Sep 08", "Module.md"),
        "Week 1: Pricing\n- Page: Pricing Case",
        {
          unlock_at: "2026-09-08T00:00:00.000Z",
        },
      )
      await put(join(paths.root, "Week 01 - Sep 08", "pricing-case.md"), "Pricing case content.")
      const failedRunner = new AISDKAgentRunner({
        runsDir: join(root, ".agent-runs-failed"),
        tools: {},
        model: new MockLanguageModelV4({
          provider: "mock",
          modelId: "mock-error",
          doGenerate: () => {
            throw new Error("provider unavailable")
          },
        }),
      })

      // When: the model adapter rejects the request.
      const failedGeneration = generatePrepBrief({
        vaultRoot: root,
        config: config(),
        course,
        period: { kind: "week", value: "2026-09-08" },
        index,
        runner: failedRunner,
        triage: { summarize: async () => "unused" },
      })

      // Then: callers receive a typed error with a safe retry action.
      await expect(failedGeneration).rejects.toBeInstanceOf(PrepGenerationError)
      await expect(failedGeneration).rejects.toThrow("Retry school prep")
    } finally {
      index.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses to generate and makes zero model calls when the monthly spend cap is already exceeded", async () => {
    // Given: a spend cap already met by prior month-to-date usage.
    const root = await fixtureVault()
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      const cappedConfig: SchoolConfig = { ...config(), cost: { maxMonthlySpendUSD: 1 } }
      index.upsertTokenUsage({
        syncRunCanvasId: "prior-run",
        model: "google/gemini-3.7-flash",
        functionName: "prepBrief",
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

      // When: prep is requested while over the cap.
      const attempt = generatePrepBrief({
        vaultRoot: root,
        config: cappedConfig,
        course,
        period: { kind: "week", value: "2026-09-08" },
        index,
        runner: cappedRunner,
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

  const cuePricingCase = [
    "Week 1 agenda: price the new product using contribution margin.",
    "Set price where marginal revenue equals marginal cost; contribution margin gives a floor. The case describes price-sensitive buyers, distinct routes, and cautions against responding to every rival price cut.",
    "Prepare your answers to the following questions:",
    "1. What price maximizes contribution margin?",
    "2. How should the team handle rival price cuts?",
  ].join(" ")

  async function fixtureVaultWithCue(): Promise<string> {
    const root = await fixtureVault()
    await put(
      join(
        coursePaths(root, course.code, course.canvasId).modules,
        "01-pricing",
        "pricing-case.md",
      ),
      cuePricingCase,
    )
    await put(
      join(
        coursePaths(root, course.code, course.canvasId).root,
        "Week 01 - Sep 08",
        "pricing-case.md",
      ),
      cuePricingCase,
    )
    return root
  }

  const briefWithoutAnswers = brief

  function briefWithAnswers(secondAnswer: string): string {
    return [
      briefWithoutAnswers,
      "## Answers",
      "### 1. What price maximizes contribution margin?",
      "Set price where marginal revenue equals marginal cost; contribution margin gives a floor.",
      `### 2. How should the team handle rival price cuts?\n${secondAnswer}`,
    ].join("\n")
  }

  describe("deliverable detection — coverage validator", () => {
    it("fails when a detected item's answer is missing", async () => {
      // Given: a module doc carrying a discussion-questions cue, and a brief
      // whose second answer is empty.
      const root = await fixtureVaultWithCue()
      const index = createSchoolIndex({ path: ":memory:" })
      try {
        const attempt = generatePrepBrief({
          vaultRoot: root,
          config: config(),
          course,
          period: { kind: "week", value: "2026-09-08" },
          index,
          runner: runner(join(root, ".agent-runs"), briefWithAnswers("")),
          triage: { summarize: async () => "unused" },
        })

        // Then: the fabrication/coverage guard rejects it, naming the item.
        await expect(attempt).rejects.toBeInstanceOf(PrepContentError)
        await expect(attempt).rejects.toThrow(/missing or empty answer for item 2/)
      } finally {
        index.close()
        await rm(root, { recursive: true, force: true })
      }
    })

    it("passes when every detected item has substantive source-linked detail under Answers", async () => {
      // Given: the same cue, but a brief that answers both items in full.
      const root = await fixtureVaultWithCue()
      const index = createSchoolIndex({ path: ":memory:" })
      try {
        const result = await generatePrepBrief({
          vaultRoot: root,
          config: config(),
          course,
          period: { kind: "week", value: "2026-09-08" },
          index,
          runner: runner(
            join(root, ".agent-runs"),
            briefWithAnswers(
              "Match selectively only on price-sensitive buyers and distinct routes; the case warns against responding to every rival price cut.",
            ),
          ),
          triage: { summarize: async () => "unused" },
        })

        // Then: the brief is delivered with the injected Answers section intact.
        const output = parseVaultDocument(await readFile(result.path, "utf8"), result.path)
        expect(output.content).toContain("## Answers")
        expect(output.content).toContain("### 1. What price maximizes contribution margin?")
        expect(output.content).toContain("Match selectively only on price-sensitive buyers")
      } finally {
        index.close()
        await rm(root, { recursive: true, force: true })
      }
    })

    it("refuses to mark generic filler answers auto-final", async () => {
      const root = await fixtureVaultWithCue()
      const index = createSchoolIndex({ path: ":memory:" })
      try {
        const attempt = generatePrepBrief({
          vaultRoot: root,
          config: config(),
          course,
          period: { kind: "week", value: "2026-09-08" },
          index,
          runner: runner(
            join(root, ".agent-runs"),
            briefWithAnswers(
              "Both effects in the readings are important research concepts and should be considered carefully.",
            ),
          ),
          triage: { summarize: async () => "unused" },
        })
        await expect(attempt).rejects.toThrow("too generic or lacks clear source overlap")
        await expect(
          readFile(
            join(
              coursePaths(root, course.code, course.canvasId).root,
              "Week 01 - Sep 08",
              "Prep",
              "week 2026-09-08.md",
            ),
            "utf8",
          ),
        ).rejects.toThrow()
      } finally {
        index.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  })

  describe("deliverable detection — guidance suppression", () => {
    it("a declared '## Deliverable' of none suppresses detection even though a cue is present", async () => {
      // Given: a module doc carrying a detectable cue, but the class guidance
      // explicitly opts out of auto-detection.
      const root = await fixtureVaultWithCue()
      await put(
        join(coursePaths(root, course.code, course.canvasId).guidance, "prep-guidance.md"),
        ["Focus on the decision and its risks.", "## Deliverable", "none"].join("\n"),
      )
      const index = createSchoolIndex({ path: ":memory:" })
      try {
        // When: a brief without any Answers section is generated.
        const result = await generatePrepBrief({
          vaultRoot: root,
          config: config(),
          course,
          period: { kind: "week", value: "2026-09-08" },
          index,
          runner: runner(join(root, ".agent-runs"), briefWithoutAnswers),
          triage: { summarize: async () => "unused" },
        })

        // Then: no answers section was required — suppression won over detection.
        const output = parseVaultDocument(await readFile(result.path, "utf8"), result.path)
        expect(output.content).not.toContain("## Answers")
      } finally {
        index.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  })

  describe("deliverable detection — answers section reuse", () => {
    it("reuses a declared answers-ish section instead of injecting a duplicate", async () => {
      // Given: guidance declares its own structure with an answers-ish section name.
      const root = await fixtureVaultWithCue()
      await put(
        join(coursePaths(root, course.code, course.canvasId).guidance, "prep-guidance.md"),
        ["Quantify the trade-offs.", "## Brief structure", "Agenda", "Discussion Answers"].join(
          "\n",
        ),
      )
      const customBrief = [
        "## Agenda",
        "- Price the new product.",
        "## Discussion Answers",
        "### 1. What price maximizes contribution margin?",
        "The price setting marginal revenue equal to marginal cost.",
        "### 2. How should the team handle rival price cuts?",
        "Match selectively only on price-sensitive routes.",
      ].join("\n")
      const index = createSchoolIndex({ path: ":memory:" })
      try {
        // When: a brief using the declared section is generated.
        const result = await generatePrepBrief({
          vaultRoot: root,
          config: config(),
          course,
          period: { kind: "week", value: "2026-09-08" },
          index,
          runner: runner(join(root, ".agent-runs"), customBrief),
          triage: { summarize: async () => "unused" },
        })

        // Then: the declared section is reused — no separate "## Answers" is required or injected.
        const output = parseVaultDocument(await readFile(result.path, "utf8"), result.path)
        expect(output.content).toContain("## Discussion Answers")
        expect(output.content).not.toContain("## Answers\n")
      } finally {
        index.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  })

  describe("deliverable detection — non-regression", () => {
    it("no declared guidance and no detectable cue leaves the default sections untouched", async () => {
      // Given: the plain fixture vault, with no cue anywhere and no guidance declaration.
      const root = await fixtureVault()
      const index = createSchoolIndex({ path: ":memory:" })
      try {
        const result = await generatePrepBrief({
          vaultRoot: root,
          config: config(),
          course,
          period: { kind: "week", value: "2026-09-08" },
          index,
          runner: runner(join(root, ".agent-runs"), brief),
          triage: { summarize: async () => "unused" },
        })

        // Then: no answers section was injected, and every historical default section is present.
        const output = parseVaultDocument(await readFile(result.path, "utf8"), result.path)
        expect(output.content).not.toContain("## Answers")
        for (const section of [
          "Agenda",
          "Readings",
          "Concepts",
          "Assignments Due",
          "Prep Checklist",
        ]) {
          expect(output.content).toContain(`## ${section}`)
        }
      } finally {
        index.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  })
})
