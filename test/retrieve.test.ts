import { createHash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import type { SchoolConfig } from "../src/config/index.js"
import { assembleCourseContext } from "../src/engines/retrieve.js"
import { coursePaths, vaultPaths } from "../src/store/paths.js"
import { renderVaultDocument } from "../src/store/vault.js"
import type { VaultFrontmatter } from "../src/store/vault-document.js"
import { realSchoolModels, schoolConfig } from "./helpers/schoolConfig.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

const course = { code: "STRAT 101", canvasId: "course-17" } as const

function config(): SchoolConfig {
  return schoolConfig({
    vaultPath: "unused",
    indexPath: ":memory:",
    pilotCourseId: null,
    canvas: { baseUrl: "https://canvas.example.invalid" },
    models: realSchoolModels,
  })
}

function document(content: string, restricted = false): string {
  const frontmatter: VaultFrontmatter = {
    canvas_id: "fixture",
    canvas_url: "https://canvas.example.invalid/resource",
    type: "fixture",
    dates: {},
    content_hash: createHash("sha256").update(content).digest("hex"),
    source: "sync",
    status: "approved",
    ai_policy: "allowed",
    redistribution: restricted ? "restricted" : "allowed",
  }
  return renderVaultDocument(frontmatter, content)
}

async function put(path: string, content: string, restricted = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, document(content, restricted), "utf8")
}

async function fixtureVault(): Promise<string> {
  const root = await temporaryDirectory("school-agent-retrieve-")
  const paths = coursePaths(root, course.code, course.canvasId)
  await put(paths.syllabus, "Syllabus: pricing cases use contribution margin.\n")
  await put(paths.playbook, "Course playbook: quantify trade-offs.\n")
  await put(join(paths.guidance, "prep-guidance.md"), "Guidance: explain the decision.\n")
  await put(
    join(paths.assignments, "pricing.md"),
    "Pricing assignment: calculate contribution margin.\n",
  )
  await put(join(paths.files, "overview.md"), `${"Overview strategy material. ".repeat(40)}\n`)
  await put(join(paths.files, "restricted.md"), "Restricted answer key for pricing.\n", true)
  await put(
    paths.index,
    [
      "| title | type | dates | path | token estimate |",
      "| --- | --- | --- | --- | --- |",
      "| Pricing assignment | assignment | 2026-09-01 | assignments/pricing.md | 10 |",
      "| Strategy overview | file | | files/overview.md | 400 |",
      "| Restricted answer key | file | | files/restricted.md | 10 |",
    ].join("\n"),
  )
  return root
}

describe("assembleCourseContext", () => {
  it("selects from the manifest before pulling only the matching full text and logs exact tiers", async () => {
    // Given: a course manifest with one matching assignment and one restricted artifact.
    const root = await fixtureVault()
    try {
      let summaries = 0

      // When: a pricing assignment context is assembled under a bounded budget.
      const result = await assembleCourseContext({
        vaultRoot: root,
        course,
        task: "Draft the pricing assignment using contribution margin",
        runId: "run-pricing",
        functionName: "assignmentDraft",
        config: config(),
        tokenBudget: 120,
        triage: {
          summarize: async () => {
            summaries += 1
            return "overview"
          },
        },
      })

      // Then: Tier 1 selects the assignment, Tier 2 excludes unselected and restricted files.
      expect(result.selected).toEqual(["assignments/pricing.md"])
      expect(result.sources).toContainEqual({ path: "_index.md", tier: "manifest" })
      expect(result.sources).toContainEqual({ path: "assignments/pricing.md", tier: "full-text" })
      expect(result.sources).not.toContainEqual({ path: "files/overview.md", tier: "full-text" })
      expect(result.sources).not.toContainEqual({ path: "files/restricted.md", tier: "full-text" })
      expect(result.context).toContain("Pricing assignment")
      expect(result.context).not.toContain("Restricted answer key")
      expect(summaries).toBe(0)
      expect(result.estimatedTokens).toBeLessThanOrEqual(120)

      const log = await readFile(vaultPaths(root).metadata.contextLog, "utf8")
      expect(JSON.parse(log)).toMatchObject({
        runId: "run-pricing",
        function: "assignmentDraft",
        provider: "anthropic",
        model: "anthropic/claude-3-7-sonnet",
        sources: result.sources,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("generates one cached sidecar for selected large material and keeps the stable assembly prefix", async () => {
    // Given: a large overview artifact selected by its manifest title.
    const root = await fixtureVault()
    try {
      let summaries = 0
      const input = {
        vaultRoot: root,
        course,
        task: "Use the strategy overview",
        functionName: "prepBrief" as const,
        config: config(),
        tokenBudget: 500,
        triage: {
          summarize: async () => {
            summaries += 1
            return "Strategy overview summary"
          },
        },
      }

      // When: the same request is assembled twice.
      const first = await assembleCourseContext({ ...input, runId: "run-overview-1" })
      const second = await assembleCourseContext({ ...input, runId: "run-overview-2" })

      // Then: the sidecar is reused and the cacheable context prefix is byte-identical.
      expect(summaries).toBe(1)
      expect(first.context).toBe(second.context)
      expect(first.sources).toContainEqual({
        path: "files/overview.md.summary.md",
        tier: "summary",
      })
      await expect(
        readFile(
          join(coursePaths(root, course.code, course.canvasId).files, "overview.md.summary.md"),
          "utf8",
        ),
      ).resolves.toContain("Strategy overview summary")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("notes truncation and returns an explicit empty message when every manifest artifact is restricted", async () => {
    // Given: an oversized matching artifact, then a manifest containing only a restricted artifact.
    const root = await fixtureVault()
    try {
      const oversized = await assembleCourseContext({
        vaultRoot: root,
        course,
        task: "pricing assignment",
        runId: "run-truncated",
        functionName: "prepBrief",
        config: config(),
        tokenBudget: 30,
        triage: { summarize: async () => "Strategy overview summary" },
      })
      expect(oversized.context).toContain("[Truncated to fit the 30-token context budget]")

      const paths = coursePaths(root, course.code, course.canvasId)
      await put(
        paths.index,
        [
          "| title | type | dates | path | token estimate |",
          "| --- | --- | --- | --- | --- |",
          "| Restricted answer key | file | | files/restricted.md | 10 |",
        ].join("\n"),
      )
      const empty = await assembleCourseContext({
        vaultRoot: root,
        course,
        task: "pricing",
        runId: "run-empty",
        functionName: "assignmentDraft",
        config: config(),
        tokenBudget: 120,
        triage: { summarize: async () => "unused" },
      })

      // Then: restricted input is absent from both tiers and the caller gets a clear state.
      expect(empty.selected).toEqual([])
      expect(empty.sources).toEqual([{ path: "_index.md", tier: "manifest" }])
      expect(empty.context).toContain("No eligible context is available")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("excludes a manifest-restricted artifact before trying to parse its full text", async () => {
    // Given: Tier 1 marks an artifact restricted but its on-disk body is intentionally unreadable.
    const root = await fixtureVault()
    try {
      const paths = coursePaths(root, course.code, course.canvasId)
      await writeFile(join(paths.files, "restricted.md"), "Tier 2 must not open this file.", "utf8")
      await put(
        paths.index,
        [
          "| title | type | dates | path | token estimate | redistribution |",
          "| --- | --- | --- | --- | --- | --- |",
          "| Restricted pricing key | file | | files/restricted.md | 400 | restricted |",
        ].join("\n"),
      )

      // When: default exclusion assembles context from the restricted-only manifest.
      const result = await assembleCourseContext({
        vaultRoot: root,
        course,
        task: "pricing key",
        runId: "run-manifest-restricted",
        functionName: "assignmentDraft",
        config: config(),
        tokenBudget: 120,
        triage: { summarize: async () => "must not run" },
      })

      // Then: the unreadable body is absent from both Tier 1 and Tier 2 usage.
      expect(result.selected).toEqual([])
      expect(result.sources).toEqual([{ path: "_index.md", tier: "manifest" }])
      expect(result.context).toContain("No eligible context is available")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("stops selection at the token budget and never reads an oversized artifact", async () => {
    // Given: a huge (15000-token) and a small (30-token) matching file. Ties on
    // keyword score, so the huge path sorts first and must be budget-gated out.
    const root = await fixtureVault()
    try {
      const paths = coursePaths(root, course.code, course.canvasId)
      const hugeContent = "$$$".repeat(20_000)
      await put(join(paths.files, "huge.md"), hugeContent)
      await put(join(paths.files, "small.md"), "Small note: contribution margin drives pricing.\n")
      await put(
        paths.index,
        [
          "| title | type | dates | path | token estimate |",
          "| --- | --- | --- | --- | --- |",
          "| Huge data file | file | | files/huge.md | 15000 |",
          "| Small note | file | | files/small.md | 30 |",
        ].join("\n"),
      )
      let summaries = 0

      // When: a budget far below the huge file's size is enforced.
      const result = await assembleCourseContext({
        vaultRoot: root,
        course,
        task: "draft from the huge data file and the small note",
        runId: "run-budget",
        functionName: "assignmentDraft",
        config: config(),
        tokenBudget: 100,
        triage: {
          summarize: async () => {
            summaries += 1
            return "huge summary would only be generated if the huge file were read"
          },
        },
      })

      // Then: the huge file is skipped (never read, never selected, never
      // summarized) while the small file lands in the context.
      expect(result.selected).toEqual(["files/small.md"])
      expect(result.sources).toContainEqual({ path: "files/small.md", tier: "full-text" })
      expect(result.sources).not.toContainEqual({ path: "files/huge.md", tier: "full-text" })
      expect(result.context).toContain("Small note")
      expect(result.context).not.toContain("$$$")
      expect(summaries).toBe(0)
      expect(result.estimatedTokens).toBeLessThanOrEqual(100)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("prioritizes an assignment-linked file ahead of keyword matches and summarizes it when oversized", async () => {
    // Given: a small keyword-matching noise file and a large priority file that
    // would never fit the token budget as full text.
    const root = await fixtureVault()
    try {
      const paths = coursePaths(root, course.code, course.canvasId)
      await put(join(paths.files, "big-case.md"), "$$$".repeat(20_000))
      await put(join(paths.files, "noise.md"), "Small note: contribution margin drives pricing.\n")
      await put(
        paths.index,
        [
          "| title | type | dates | path | token estimate |",
          "| --- | --- | --- | --- | --- |",
          "| Noise note | file | | files/noise.md | 30 |",
        ].join("\n"),
      )
      let summaries = 0

      // When: the priority file is passed alongside a budget too small to fit it.
      const result = await assembleCourseContext({
        vaultRoot: root,
        course,
        task: "contribution margin pricing note",
        runId: "run-priority-summary",
        functionName: "assignmentDraft",
        config: config(),
        tokenBudget: 100,
        triage: {
          summarize: async () => {
            summaries += 1
            return "Big case summary"
          },
        },
        priorityPaths: ["files/big-case.md"],
      })

      // Then: the priority file is never skipped — it lands as a summary, ahead
      // of the keyword-matched noise file, and is never budget-starved out.
      expect(summaries).toBe(1)
      expect(result.sources).toContainEqual({
        path: "files/big-case.md.summary.md",
        tier: "summary",
      })
      expect(result.context).toContain("Big case summary")
      expect(result.selected[0]).toBe("files/big-case.md.summary.md")
      expect(result.selected).toContain("files/noise.md")
      const bigIndex = result.context.indexOf("Big case summary")
      const noiseIndex = result.context.indexOf("Small note")
      expect(bigIndex).toBeGreaterThan(-1)
      expect(noiseIndex).toBeGreaterThan(-1)
      expect(bigIndex).toBeLessThan(noiseIndex)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("includes a priority file that fits as full text, leading the materials", async () => {
    // Given: a small priority file distinct from anything keyword-matched.
    const root = await fixtureVault()
    try {
      const paths = coursePaths(root, course.code, course.canvasId)
      await put(join(paths.files, "case-brief.md"), "Case brief: ExampleCo pricing decision.\n")

      // When: it is passed as a priority path under a budget that fits it.
      const result = await assembleCourseContext({
        vaultRoot: root,
        course,
        task: "Draft the pricing assignment using contribution margin",
        runId: "run-priority-fulltext",
        functionName: "assignmentDraft",
        config: config(),
        tokenBudget: 200,
        triage: { summarize: async () => "unused" },
        priorityPaths: ["files/case-brief.md"],
      })

      // Then: it is included as full text and precedes the keyword match.
      expect(result.selected[0]).toBe("files/case-brief.md")
      expect(result.sources).toContainEqual({ path: "files/case-brief.md", tier: "full-text" })
      expect(result.context).toContain("Case brief: ExampleCo pricing decision.")
      const caseIndex = result.context.indexOf("Case brief")
      const pricingIndex = result.context.indexOf("Pricing assignment: calculate")
      expect(caseIndex).toBeLessThan(pricingIndex)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
