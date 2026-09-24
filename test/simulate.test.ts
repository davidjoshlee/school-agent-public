import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import type { AgentRunner, AgentRunRecord, AgentRunResult } from "../src/agents/runner.js"
import type { SchoolConfig } from "../src/config/index.js"
import { selectModulesForAssignment } from "../src/engines/retrieve-selection.js"
import { runSimulation } from "../src/engines/simulate.js"
import { coursePaths, slugify } from "../src/store/paths.js"
import { renderVaultDocument } from "../src/store/vault.js"
import { createVaultFrontmatter } from "../src/store/vault-document.js"
import { schoolConfig } from "./helpers/schoolConfig.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

const course = {
  code: "STRAT 101",
  canvasId: "course-17",
  canvasUrl: "https://canvas.example.invalid/courses/course-17",
  aiPolicy: "allowed" as const,
} as const

function config(root: string): SchoolConfig {
  return schoolConfig({
    vaultPath: root,
    canvas: { baseUrl: "https://canvas.example.invalid" },
    courses: { pilotCourseId: course.canvasId },
  })
}

function simulationRunDir(
  asOf: string,
  pilotCourseCode = basename(coursePaths("", course.code, course.canvasId).root),
): string {
  const weekKey = `${slugify(pilotCourseCode, `course-${course.canvasId}`)}-${slugify(course.canvasId, "unknown")}-${asOf}`
  return join(weekKey, coursePaths("", course.code, course.canvasId).root)
}

function document(content: string, dates: Readonly<Record<string, string>>): string {
  return renderVaultDocument(
    createVaultFrontmatter({
      canvasId: content.replaceAll(/\W+/g, "-").slice(0, 64),
      canvasUrl: "https://canvas.example.invalid/resource",
      type: "fixture",
      content,
      dates,
      source: "sync",
      status: "final",
      aiPolicy: "allowed",
    }),
    content,
  )
}

async function put(
  path: string,
  content: string,
  dates: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, document(content, dates), "utf8")
}

async function fixtureVault(): Promise<string> {
  const root = await temporaryDirectory("school-agent-simulate-")
  const paths = coursePaths(root, course.code, course.canvasId).legacy
  const indexContent = [
    "# STRAT 101",
    "",
    "| Title | Type | Dates | Path | Tokens | Restriction |",
    "| --- | --- | --- | --- | ---: | --- |",
    "| Week one case | module | 2025-01-01 | modules/week-one.md | 20 | allowed |",
    "| Week two case | module | 2025-01-08 | modules/week-two.md | 20 | allowed |",
    "| Pricing memo | assignment | 2025-01-01 | assignments/pricing-memo.md | 20 | allowed |",
    "| Solution key | page | 2025-02-01 | modules/solution-key.md | 20 | allowed |",
    "| Mystery | page | unknown | modules/mystery.md | 20 | allowed |",
  ].join("\n")
  await mkdir(dirname(paths.index), { recursive: true })
  await writeFile(
    paths.index,
    renderVaultDocument(
      createVaultFrontmatter({
        canvasId: course.canvasId,
        canvasUrl: course.canvasUrl,
        type: "_index.md",
        content: indexContent,
        dates: { created_at: "2024-12-01T00:00:00.000Z" },
        source: "sync",
        status: "final",
        aiPolicy: "allowed",
      }),
      indexContent,
    ),
    "utf8",
  )
  await put(join(paths.modules, "week-one.md"), "Week one pricing case", {
    posted_at: "2025-01-01T00:00:00.000Z",
  })
  await put(join(paths.modules, "week-two.md"), "Week two strategy case", {
    posted_at: "2025-01-08T00:00:00.000Z",
  })
  await put(join(paths.assignments, "pricing-memo.md"), "Pricing memo\n\nGroup category: group-1", {
    due_at: "2025-01-01T00:00:00.000Z",
  })
  await put(join(paths.modules, "solution-key.md"), "Future solution", {
    posted_at: "2025-02-01T00:00:00.000Z",
  })
  await put(join(paths.modules, "mystery.md"), "No visible date", {})
  return root
}

async function simulationFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { recursive: true })
  const files = entries.filter((entry) => entry.endsWith(".md") || entry.endsWith(".json")).sort()
  return Promise.all(
    files.map(async (file) => {
      const content = await readFile(join(root, file), "utf8")
      return `${file}\n${content.replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>")}`
    }),
  )
}

async function moduleScopedVault(): Promise<string> {
  const root = await temporaryDirectory("school-agent-simulate-module-")
  const paths = coursePaths(root, course.code, course.canvasId)
  const indexContent = [
    "# STRAT 101",
    "",
    "| Title | Type | Dates | Path | Tokens | Restriction |",
    "| --- | --- | --- | --- | ---: | --- |",
    "| Module one | module | 2025-01-01 | modules/week-one.md | 20 | allowed |",
    "| Pricing memo | assignment | 2025-01-01 | assignments/pricing-memo.md | 20 | allowed |",
    "| Other case | assignment | 2025-01-01 | assignments/other-case.md | 20 | allowed |",
    "| Guidance | guidance | unknown | guidance/prep-guidance.md | 20 | allowed |",
  ].join("\n")
  await mkdir(dirname(paths.index), { recursive: true })
  await writeFile(
    paths.index,
    renderVaultDocument(
      createVaultFrontmatter({
        canvasId: course.canvasId,
        canvasUrl: course.canvasUrl,
        type: "_index.md",
        content: indexContent,
        dates: { created_at: "2024-12-01T00:00:00.000Z" },
        source: "sync",
        status: "final",
        aiPolicy: "allowed",
      }),
      indexContent,
    ),
    "utf8",
  )
  const moduleContent = "Module one\n\n- Assignment: Pricing memo"
  const modulePath = join(paths.root, "modules", "week-one.md")
  await mkdir(dirname(modulePath), { recursive: true })
  await writeFile(
    modulePath,
    renderVaultDocument(
      createVaultFrontmatter({
        canvasId: "1701",
        canvasUrl: "https://canvas.example.invalid/modules/1701",
        type: "modules",
        content: moduleContent,
        dates: { posted_at: "2025-01-01T00:00:00.000Z" },
        source: "sync",
        status: "final",
        aiPolicy: "allowed",
      }),
      moduleContent,
    ),
    "utf8",
  )
  const guidanceContent = "Focus on the decision and its risks."
  const guidancePath = join(paths.root, "Resources", "Guidance", "prep-guidance.md")
  await mkdir(dirname(guidancePath), { recursive: true })
  await writeFile(
    guidancePath,
    renderVaultDocument(
      createVaultFrontmatter({
        canvasId: "gp-1",
        canvasUrl: "https://canvas.example.invalid/guidance",
        type: "guidance",
        content: guidanceContent,
        source: "agent",
        status: "final",
        aiPolicy: "allowed",
      }),
      guidanceContent,
    ),
    "utf8",
  )
  await put(
    join(paths.root, "Assignments", "Pricing memo", "00 Prompt.md"),
    "Pricing memo\n\nGroup category: group-1",
    {
      due_at: "2025-01-01T00:00:00.000Z",
    },
  )
  await put(
    join(paths.root, "Assignments", "Other case", "00 Prompt.md"),
    "Other case\n\nGroup category: group-2",
    {
      due_at: "2025-01-01T00:00:00.000Z",
    },
  )
  return root
}

/**
 * Two session modules, dated only by the derived `session_at` signal (no
 * `unlock_at` at all — the common real-Canvas shape). Module 8's window is
 * `[2025-10-09, 2025-10-16)` (session_at 2025-10-16 minus the 7-day lead);
 * module 9's is a week later. Exercises the coordinator-requested contract:
 * a module released on or before asOf is staged into the simulation
 * sandbox, a future one is not, and `selectModulesForAssignment` finds the
 * staged module structure (not keyword-fallback) once it's there.
 */
async function moduleReleaseVault(): Promise<string> {
  const root = await temporaryDirectory("school-agent-simulate-release-")
  const paths = coursePaths(root, course.code, course.canvasId).legacy
  const indexContent = [
    "# STRAT 101",
    "",
    "| Title | Type | Dates | Path | Tokens | Restriction |",
    "| --- | --- | --- | --- | ---: | --- |",
    "| Session 8 | module | unknown | modules/session-8.md | 20 | allowed |",
    "| Session 9 | module | unknown | modules/session-9.md | 20 | allowed |",
    "| ExampleCo | assignment | unknown | assignments/exampleco.md | 20 | allowed |",
  ].join("\n")
  await mkdir(dirname(paths.index), { recursive: true })
  await writeFile(
    paths.index,
    renderVaultDocument(
      createVaultFrontmatter({
        canvasId: course.canvasId,
        canvasUrl: course.canvasUrl,
        type: "_index.md",
        content: indexContent,
        dates: { created_at: "2024-12-01T00:00:00.000Z" },
        source: "sync",
        status: "final",
        aiPolicy: "allowed",
      }),
      indexContent,
    ),
    "utf8",
  )
  const session8Content = "Session 8\n\n- Assignment: ExampleCo (canvas_id: 8001)"
  await put(join(paths.modules, "session-8.md"), session8Content, { session_at: "2025-10-16" })
  const session9Content = "Session 9"
  await put(join(paths.modules, "session-9.md"), session9Content, { session_at: "2025-10-23" })
  await put(join(paths.assignments, "exampleco.md"), "ExampleCo assignment prompt.", {
    due_at: "2025-10-20T00:00:00.000Z",
  })
  return root
}

class FixedRunner implements AgentRunner {
  constructor(private readonly result: AgentRunResult) {}

  async run(prompt: string): Promise<AgentRunResult> {
    const source = [...prompt.matchAll(/^### ([^\n]+\.md)$/gm)]
      .map((match) => match[1])
      .find((path) => path !== undefined)
    const text = this.result.text?.replace("AUTO_SOURCE", source ?? "missing-source.md") ?? null
    return { ...this.result, text }
  }

  async approve(): Promise<AgentRunResult> {
    return this.result
  }

  async revise(): Promise<AgentRunResult> {
    return this.result
  }

  // The real runner's durable record is read back after every draft to
  // extract `calculate` tool calls for the correctness check (see
  // `extractComputations` in `src/agents/run-tools.ts`); this fixture never
  // calls the tool, so an empty message history is a faithful stand-in.
  async get(): Promise<AgentRunRecord> {
    const now = new Date(0).toISOString()
    return {
      id: this.result.runId,
      createdAt: now,
      updatedAt: now,
      messages: [],
      resultText: this.result.text,
      error: null,
      status: this.result.status,
      pendingApproval: this.result.pendingApproval,
    } as AgentRunRecord
  }

  async list(): Promise<AgentRunRecord[]> {
    return []
  }
}

const prepRunner = new FixedRunner({
  runId: "00000000-0000-4000-8000-000000000001",
  status: "completed",
  text: [
    "## Agenda\nPricing",
    "## Readings\n- [Case](AUTO_SOURCE)",
    "## Concepts\nPricing",
    "## Assignments Due\nNone",
    "## Prep Checklist\nRead",
  ].join("\n\n"),
})
const draftRunner = new FixedRunner({
  runId: "00000000-0000-4000-8000-000000000002",
  status: "pending_approval",
  text: "A gated draft.",
})

describe("as-of simulation", () => {
  it("excludes post-dated and unknown material while keeping deterministic sandboxed reports", async () => {
    // Given: a synced pilot snapshot with one future solution and one unknown-visibility page.
    const root = await fixtureVault()
    try {
      // When: the same two-week replay is run twice with fixed identities and model results.
      const first = await runSimulation({
        config: config(root),
        weeks: "2025-01-01..2025-01-08",
        runners: { prep: prepRunner, assignment: draftRunner },
        triage: { summarize: async () => "unused" },
      })
      const firstFiles = await Promise.all(
        first.runDirs.map((runDir) => simulationFiles(join(root, "_simulations", runDir))),
      )
      // Replaying the identical window overwrites the same flat course-week dirs in place.
      const second = await runSimulation({
        config: config(root),
        weeks: "2025-01-01..2025-01-08",
        runners: { prep: prepRunner, assignment: draftRunner },
        triage: { summarize: async () => "unused" },
      })
      const secondFiles = await Promise.all(
        second.runDirs.map((runDir) => simulationFiles(join(root, "_simulations", runDir))),
      )

      // Then: leakage is zero, unknown visibility is disclosed, and only simulation roots are written.
      expect(first.unknownVisibility).toBe(1)
      expect(first.leakageCount).toBe(0)
      expect(first.weeks).toHaveLength(2)
      const expectedRunDirs = [
        simulationRunDir("2025-01-01", "strat-101"),
        simulationRunDir("2025-01-08", "strat-101"),
      ]
      expect(first.runDirs).toEqual(expectedRunDirs)
      const firstWeek = first.weeks[0]
      if (firstWeek?.status !== "completed") {
        throw new Error("Expected the first replay week to produce artifacts")
      }
      expect(firstWeek.drafts).toHaveLength(1)
      expect(firstWeek.brief.sources).not.toContain("modules/solution-key.md")
      expect(second.runDirs).toEqual(first.runDirs)
      expect(secondFiles).toEqual(firstFiles)
      expect(await readdir(join(root, "_simulations"))).toEqual([
        ...expectedRunDirs.map((runDir) => runDir.split("/")[0] ?? ""),
      ])
      expect(firstFiles.flat().join("\n")).not.toContain("solution-key.md")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports an empty window without generating a real-course artifact", async () => {
    // Given: the synced pilot snapshot.
    const root = await fixtureVault()
    try {
      // When: replaying a date before any visible course material.
      const result = await runSimulation({
        config: config(root),
        weeks: "2024-01-01..2024-01-01",
        runners: { prep: prepRunner, assignment: draftRunner },
        triage: { summarize: async () => "unused" },
      })

      // Then: the explicit empty week produces no course-week directory, report, or _simulations dir.
      expect(result.weeks).toEqual([{ asOf: "2024-01-01", status: "empty" }])
      expect(result.runDirs).toEqual([])
      expect(await readdir(root)).toEqual(["strat-101"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("drafts only the assignments a chosen module references", async () => {
    // Given: a snapshot with a module that references only the pricing memo.
    const root = await moduleScopedVault()
    try {
      // When: the week is replayed scoped to module 1701.
      const result = await runSimulation({
        config: config(root),
        weeks: "2025-01-01..2025-01-01",
        runners: { prep: prepRunner, assignment: draftRunner },
        triage: { summarize: async () => "unused" },
        moduleCanvasId: "1701",
      })
      const week = result.weeks[0]
      if (week?.status !== "completed") {
        throw new Error("Expected the module-scoped week to produce artifacts")
      }

      // Then: only the module's assignment is drafted, not every visible assignment.
      expect(result.runDirs).toEqual([simulationRunDir("2025-01-01")])
      expect(week.drafts).toHaveLength(1)
      expect(week.drafts[0]?.path).toBe("Assignments/Undated - Pricing memo/Drafts/Pricing memo.md")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("stages guidance into the replay sandbox even though it carries no date signal", async () => {
    // Given: a snapshot whose guidance file has no date (unknown visibility).
    const root = await moduleScopedVault()
    try {
      // When: the week is replayed.
      const result = await runSimulation({
        config: config(root),
        weeks: "2025-01-01..2025-01-01",
        runners: { prep: prepRunner, assignment: draftRunner },
        triage: { summarize: async () => "unused" },
      })

      // Then: the guidance is present directly in the flat course-week dir so the replay can read it.
      expect(await readdir(root)).toEqual([
        "_simulations",
        basename(coursePaths(root, course.code, course.canvasId).root),
      ])
      const staged = await readFile(
        join(
          root,
          "_simulations",
          result.runDirs[0] ?? "missing-run",
          "Resources",
          "Guidance",
          "prep-guidance.md",
        ),
        "utf8",
      )
      expect(staged).toContain("Focus on the decision")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("stages a module released on or before asOf but withholds a future module, and reports the per-signal visibility breakdown", async () => {
    // Given: two session modules dated only by derived session_at (module 8's
    // window opens 2025-10-09; module 9's opens a week later).
    const root = await moduleReleaseVault()
    const releasePrepRunner = new FixedRunner({
      runId: "00000000-0000-4000-8000-000000000003",
      status: "completed",
      text: [
        "## Agenda\nSession 8",
        "## Readings\n- [Case](modules/session-8.md)",
        "## Concepts\nSession 8",
        "## Assignments Due\nNone",
        "## Prep Checklist\nRead",
      ].join("\n\n"),
    })
    try {
      // When: replaying asOf 2025-10-10, inside module 8's window and before module 9's.
      const result = await runSimulation({
        config: config(root),
        weeks: "2025-10-10..2025-10-10",
        runners: { prep: releasePrepRunner, assignment: draftRunner },
        triage: { summarize: async () => "unused" },
      })

      // Then: the run completes and its report discloses the per-signal visibility breakdown —
      // both modules resolve via their own derived session_at (module_release), and the
      // assignment resolves via its own due_at.
      expect(result.leakageCount).toBe(0)
      const week = result.weeks[0]
      if (week?.status !== "completed") {
        throw new Error("Expected the release-window week to produce artifacts")
      }
      const runDir = result.runDirs[0]
      if (runDir === undefined) {
        throw new Error("Expected a course-week run directory")
      }
      const runRoot = join(root, "_simulations", runDir)
      const report = JSON.parse(await readFile(join(runRoot, "report.json"), "utf8"))
      expect(report.visibility.bySignal).toEqual({
        unlock_at: 0,
        posted_at: 0,
        module_release: 2,
        due_at: 1,
        created_at: 0,
        unknown: 0,
      })

      // Then: module 8's document is staged into the sandbox; module 9's is not (staging a
      // future module's item titles would be a mild leak).
      const stagedModules = await readdir(join(runRoot, "modules"))
      expect(stagedModules).toContain("session-8.md")
      expect(stagedModules).not.toContain("session-9.md")

      // Then: module-structured retrieval finds the staged module (not keyword-fallback) —
      // the coordinator's requirement that a staged module actually serves retrieval.
      const selection = await selectModulesForAssignment(runRoot, {
        canvasId: "8001",
        title: "ExampleCo",
      })
      expect(selection.mode).toBe("module")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
