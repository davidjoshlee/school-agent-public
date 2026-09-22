// allow: SIZE_OK — single-purpose gate bundle renderer; grounding report keeps the ritual cohesive in one file
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createSchoolIndex } from "../store/db.js"
import { type SimulationReport, simulationReportSchema } from "./simulate-report.js"

type TimelineRow = {
  readonly canvasId: string
  readonly courseCode: string
  readonly title: string
  readonly baseDueAt: string | null
  readonly effectiveDueAt: string | null
  readonly timelineDueAt: string | null
}
type DraftGrounding = {
  readonly asOf: string
  readonly path: string
  readonly sources: readonly string[]
  readonly correctnessCheck: string | null
}

export type M1GateOptions = {
  readonly vaultPath: string
  readonly indexPath: string
  readonly runId: string
  readonly evidenceDirectory: string
}

export type M1GateResult = { readonly bundlePath: string }

export class M1GateError extends Error {
  readonly name = "M1GateError"
}

export async function runM1Gate(options: M1GateOptions): Promise<M1GateResult> {
  const runRoot = join(options.vaultPath, "_simulations", options.runId)
  const [reportSource, comparison, scorecard] = await Promise.all([
    readRequired(runRoot, "report.json", options.runId),
    readRequired(runRoot, "comparison.md", options.runId),
    readRequired(runRoot, "scorecard.md", options.runId),
  ])
  const report = simulationReportSchema.parse(JSON.parse(reportSource))
  const grounding = await readGroundingRecords(runRoot, report)
  const index = createSchoolIndex({ path: options.indexPath })
  try {
    const bundlePath = join(options.evidenceDirectory, "gate-m1-bundle.md")
    const timeline = timelineRows(index)
    await mkdir(options.evidenceDirectory, { recursive: true })
    await writeFile(
      bundlePath,
      `${renderBundle({ runId: options.runId, report, comparison, scorecard, timeline, grounding })}\n`,
      "utf8",
    )
    return { bundlePath }
  } finally {
    index.close()
  }
}

async function readGroundingRecords(
  runRoot: string,
  report: SimulationReport,
): Promise<readonly DraftGrounding[]> {
  const records: DraftGrounding[] = []
  for (const week of report.weeks) {
    if (week.status !== "completed") {
      continue
    }
    for (const draft of week.drafts) {
      const draftPath = join(runRoot, draft.path)
      let body: string | null
      try {
        body = await readFile(draftPath, "utf8")
      } catch {
        body = null
      }
      records.push({
        asOf: week.asOf,
        path: draft.path,
        sources: draft.sources,
        correctnessCheck: body === null ? "draft body not found" : extractCorrectnessCheck(body),
      })
    }
  }
  return records
}

function extractCorrectnessCheck(body: string): string | null {
  const headingIndex = body.indexOf("## Correctness check")
  if (headingIndex === -1) {
    return null
  }
  return body.slice(headingIndex).trim()
}

async function readRequired(runRoot: string, filename: string, runId: string): Promise<string> {
  const path = join(runRoot, filename)
  try {
    await access(path)
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new M1GateError(
        `Simulation run ${runId} is incomplete: ${filename} is missing. Run school compare ${runId} before school gate m1.`,
      )
    }
    throw error
  }
  return readFile(path, "utf8")
}

function timelineRows(index: ReturnType<typeof createSchoolIndex>): readonly TimelineRow[] {
  return index.timelineEntries().flatMap((entry) => {
    switch (entry.kind) {
      case "announcement":
        return []
      case "assignment": {
        const effective = index.effectiveDueDate(entry.canvasId)
        return [
          {
            canvasId: entry.canvasId,
            courseCode: entry.courseCode,
            title: entry.title,
            baseDueAt: index.assignmentDueAt(entry.canvasId),
            effectiveDueAt: effective?.dueAt ?? null,
            timelineDueAt: entry.dueAt,
          },
        ]
      }
      default:
        return assertNever(entry)
    }
  })
}

function renderBundle(input: {
  readonly runId: string
  readonly report: SimulationReport
  readonly comparison: string
  readonly scorecard: string
  readonly timeline: readonly TimelineRow[]
  readonly grounding: readonly DraftGrounding[]
}): string {
  return [
    "# M1 simulation verification bundle",
    "",
    `Simulation run: ${input.runId}`,
    "",
    "## Simulation output index",
    "",
    ...renderOutputIndex(input.report),
    "",
    "## Grounding report",
    "",
    ...renderGroundingReport(input.grounding),
    "",
    "## comparison.md",
    "",
    input.comparison.trim(),
    "",
    "## Anchored human scorecard",
    "",
    input.scorecard.trim(),
    "",
    "## Leakage report",
    "",
    `- zero-post-after-as-of confirmation: ${input.report.leakageCount === 0 ? "CONFIRMED" : "FAILED"} (leakage count: ${input.report.leakageCount})`,
    `- unknown-visibility: ${input.report.unknownVisibility}`,
    "",
    "## Visibility signal breakdown",
    "",
    ...renderVisibilityBreakdown(input.report.visibility),
    "",
    "## Timeline-accuracy report",
    "",
    "Canvas effective due dates use assignment due_at plus all_dates user overrides. The timeline item must equal the effective Canvas value.",
    "",
    "| Course | Assignment | Canvas due_at | Canvas effective due_at | Timeline item | Status |",
    "| --- | --- | --- | --- | --- | --- |",
    ...renderTimelineRows(input.timeline),
    "",
    "## discrepancies.md",
    "",
    "Record every syllabus-vs-Canvas due-date discrepancy below. A listed discrepancy is a review note, not an M1 failure; a discovered but unlisted discrepancy fails M1.",
    "",
    ...renderDiscrepancyChecklist(input.timeline),
    "",
    "## PASS criteria",
    "",
    "- Grounding: every substantive claim in each draft traces to a listed vault source (the self-review **Verified** list); each **Needs verification** item is genuinely-external or un-synced material (e.g. a paywalled reading never synced), NOT core assignment content the tool should have ingested.",
    "- Leakage is zero.",
    "- No artifact below 3 and median >= 4 on the human-only anchored scorecard (usefulness).",
    "- Every syllabus-vs-Canvas discrepancy is listed above; an unlisted discrepancy is a failure.",
    "",
    "Rubric-criterion coverage is not applicable for this pilot (the graded submission is full-credit `Score: 1` with no rubric assessment), so comparison.md's rubric tables are informational only; grounding is the substantive bar.",
    "",
    "Verdict: [ ] PASS  [ ] FAIL",
    "",
    "## Human ritual — stop here",
    "",
    "1. Read the simulation output index and comparison.md for every simulated week.",
    "2. Score each pre-listed artifact yourself; do not automate usefulness scores.",
    "3. Confirm the leakage report is zero and disclose the unknown-visibility count.",
    "4. Read the Grounding report: for each draft confirm the Verified claims rest on the listed vault sources and the Needs-verification items are only genuinely-external material.",
    "5. Compare timeline items with Canvas due_at and all_dates overrides; record each syllabus discrepancy above.",
    "6. Apply the PASS criteria, record the verdict, and STOP. Do not proceed past M1 without the user's explicit pass.",
  ].join("\n")
}

function renderVisibilityBreakdown(visibility: SimulationReport["visibility"]): readonly string[] {
  if (visibility === undefined) {
    return ["No per-signal breakdown available (report.json predates this field)."]
  }
  const bySignal = visibility.bySignal
  return [
    "| Signal | Count |",
    "| --- | ---: |",
    `| unlock_at | ${bySignal.unlock_at} |`,
    `| posted_at | ${bySignal.posted_at} |`,
    `| module_release | ${bySignal.module_release} |`,
    `| due_at | ${bySignal.due_at} |`,
    `| created_at | ${bySignal.created_at} |`,
    `| unknown | ${bySignal.unknown} |`,
  ]
}

function renderOutputIndex(report: SimulationReport): readonly string[] {
  return report.weeks.flatMap((week) => {
    switch (week.status) {
      case "empty":
        return [`- Week ${week.asOf}: no simulation artifacts.`]
      case "completed":
        return [
          `- Week ${week.asOf}:`,
          `  - brief: ${week.brief.path} (sources: ${week.brief.sources.length})`,
          ...week.drafts.map(
            (draft) => `  - draft: ${draft.path} (sources: ${draft.sources.length})`,
          ),
        ]
      default:
        return assertNever(week)
    }
  })
}

function renderGroundingReport(grounding: readonly DraftGrounding[]): readonly string[] {
  if (grounding.length === 0) {
    return ["No drafts were produced by this simulation run."]
  }
  return grounding.flatMap((draft) => {
    const tiers = tierSources(draft.sources)
    return [
      `### ${draft.asOf}: ${draft.path}`,
      "",
      `Vault sources — full text: ${tiers.fullText.length}, summary: ${tiers.summary.length}, manifest: ${tiers.manifest.length}`,
      "",
      ...tiers.fullText.map((source) => `- (full text) ${source}`),
      ...tiers.summary.map((source) => `- (summary) ${source}`),
      ...tiers.manifest.map((source) => `- (manifest) ${source}`),
      "",
      "**Self-review**",
      "",
      draft.correctnessCheck === null
        ? "No self-review correctness check found in the draft."
        : draft.correctnessCheck,
      "",
    ]
  })
}

function tierSources(sources: readonly string[]): {
  readonly fullText: readonly string[]
  readonly summary: readonly string[]
  readonly manifest: readonly string[]
} {
  const summary = sources.filter((source) => source.endsWith(".summary.md"))
  const manifest = sources.filter(
    (source) => !source.endsWith(".summary.md") && source.endsWith("_index.md"),
  )
  const fullText = sources.filter(
    (source) => !source.endsWith(".summary.md") && !source.endsWith("_index.md"),
  )
  return { fullText, summary, manifest }
}

function renderTimelineRows(rows: readonly TimelineRow[]): readonly string[] {
  return rows.length === 0
    ? ["| — | No indexed assignments | — | — | — | no assignments to check |"]
    : rows.map((row) => {
        const matches = row.timelineDueAt === row.effectiveDueAt
        return `| ${row.courseCode} | ${row.title} (${row.canvasId}) | ${formatDueAt(row.baseDueAt)} | ${formatDueAt(row.effectiveDueAt)} | ${formatDueAt(row.timelineDueAt)} | ${matches ? "MATCH" : "MISMATCH"} |`
      })
}

function renderDiscrepancyChecklist(rows: readonly TimelineRow[]): readonly string[] {
  return rows.length === 0
    ? [
        "- [ ] No Canvas assignment was indexed; record any syllabus discrepancy discovered during review.",
      ]
    : rows.map(
        (row) =>
          `- [ ] ${row.courseCode}: ${row.title} — Canvas effective due: ${formatDueAt(row.effectiveDueAt)}; syllabus due: ______; discrepancy note: ______`,
      )
}

function formatDueAt(value: string | null): string {
  return value ?? "undated"
}

function assertNever(value: never): never {
  throw new M1GateError(`Unexpected simulation gate value: ${JSON.stringify(value)}`)
}
