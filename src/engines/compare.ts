import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { basename, join, relative } from "node:path"

import { z } from "zod"

import type { SchoolConfig } from "../config/index.js"
import { slugify, vaultLayout } from "../store/paths.js"
import { parseVaultDocument } from "../store/vault.js"
import { readOptional } from "../util/fs.js"
import { parseAssignmentProvenance, withoutAssignmentProvenance } from "./assignment-provenance.js"
import {
  type CompletedSimulationWeek,
  type SimulationArtifact,
  simulationReportSchema,
} from "./simulate-report.js"
import { pilotSnapshot } from "./simulate-snapshot.js"

const rubricAssessmentSchema = z.record(z.string().min(1), z.unknown())

type CompletedWeek = CompletedSimulationWeek
type ComparisonArtifact = { readonly label: string }
type GroundTruth =
  | { readonly kind: "missing" }
  | { readonly kind: "rubric"; readonly criteria: readonly string[] }

export type CompareSimulationInput = { readonly config: SchoolConfig; readonly runId: string }
export type CompareSimulationResult = {
  readonly comparisonPath: string
  readonly scorecardPath: string
}

export class ComparisonError extends Error {
  readonly name = "ComparisonError"
}

export async function compareSimulation(
  input: CompareSimulationInput,
): Promise<CompareSimulationResult> {
  const snapshot = await pilotSnapshot(input.config)
  const runRoot = join(input.config.vault.path, "_simulations", input.runId)
  const report = simulationReportSchema.parse(
    JSON.parse(await readFile(join(runRoot, "report.json"), "utf8")),
  )
  const artifacts: ComparisonArtifact[] = []
  const weeks = await Promise.all(
    report.weeks.map(async (week) => {
      if (week.status === "empty") return `## Week ${week.asOf}\n\nNo simulation artifacts.`
      return renderCompletedWeek({
        week,
        weekRoot: runRoot,
        snapshotRoot: snapshot.root,
        artifacts,
      })
    }),
  )
  const comparisonPath = join(runRoot, "comparison.md")
  const scorecardPath = join(runRoot, "scorecard.md")
  await mkdir(runRoot, { recursive: true })
  await writeFile(
    comparisonPath,
    [
      "# Ground-truth coverage comparison",
      "",
      "This is coverage against the pilot's real past feedback and week content, not similarity-to-final. The real submissions were made without this tool; the comparator must not reward mimicry.",
      "",
      ...weeks,
      "",
    ].join("\n"),
    "utf8",
  )
  await writeFile(scorecardPath, renderScorecard(artifacts), "utf8")
  return { comparisonPath, scorecardPath }
}

async function renderCompletedWeek(input: {
  readonly week: CompletedWeek
  readonly weekRoot: string
  readonly snapshotRoot: string
  readonly artifacts: ComparisonArtifact[]
}): Promise<string> {
  const weekRoot = input.weekRoot
  const briefPath = join(weekRoot, input.week.brief.path)
  const brief = parseVaultDocument(await readFile(briefPath, "utf8"), briefPath).content
  input.artifacts.push({ label: `brief: ${input.week.asOf}` })
  const briefCoverage = await weekContentCoverage({ weekRoot, brief })
  const drafts = await Promise.all(
    input.week.drafts.map((draft) =>
      renderDraftComparison({
        draft,
        weekRoot,
        snapshotRoot: input.snapshotRoot,
        artifacts: input.artifacts,
      }),
    ),
  )
  return [
    `## Week ${input.week.asOf}`,
    "",
    "### Prep brief coverage vs actual week content",
    "",
    "| Actual content | Coverage |",
    "| --- | --- |",
    ...briefCoverage.map((item) => `| ${item.path} | ${item.coverage} |`),
    "",
    ...drafts,
  ].join("\n")
}

async function renderDraftComparison(input: {
  readonly draft: SimulationArtifact
  readonly weekRoot: string
  readonly snapshotRoot: string
  readonly artifacts: ComparisonArtifact[]
}): Promise<string> {
  const draftPath = join(input.weekRoot, input.draft.path)
  const draft = parseVaultDocument(await readFile(draftPath, "utf8"), draftPath).content
  const provenance = parseAssignmentProvenance(draft)
  const content = withoutAssignmentProvenance(draft)
  input.artifacts.push({ label: `draft: ${provenance.assignment.slug}` })
  const feedbackPaths = await assignmentFeedbackPaths(
    input.snapshotRoot,
    provenance.assignment.slug,
    provenance.assignment.title,
    provenance.assignment.canvas_id,
  )
  const groundTruth = await rubricGroundTruth(feedbackPaths)
  switch (groundTruth.kind) {
    case "missing":
      return [
        `### Assignment: ${provenance.assignment.slug}`,
        "",
        "| Ground truth | Coverage |",
        "| --- | --- |",
        "| synced real submission | no ground truth |",
        "",
      ].join("\n")
    case "rubric":
      return [
        `### Assignment: ${provenance.assignment.slug}`,
        "",
        "| Rubric criterion | Draft coverage |",
        "| --- | --- |",
        ...groundTruth.criteria.map(
          (criterion) =>
            `| ${criterionLabel(criterion)} | ${criterionCoverage(content, criterion)} |`,
        ),
        "",
      ].join("\n")
  }
}

async function rubricGroundTruth(paths: readonly string[]): Promise<GroundTruth> {
  let path: string | undefined
  let source: string | null = null
  for (const candidate of paths) {
    source = await readOptional(candidate)
    if (source !== null) {
      path = candidate
      break
    }
  }
  if (source === null || path === undefined) return { kind: "missing" }
  const content = parseVaultDocument(source, path).content
  const match = /Rubric assessment:\s*```json\s*([\s\S]*?)\s*```/.exec(content)
  if (match?.[1] === undefined) return { kind: "rubric", criteria: [] }
  try {
    return {
      kind: "rubric",
      criteria: Object.keys(rubricAssessmentSchema.parse(JSON.parse(match[1]))).sort(),
    }
  } catch (error: unknown) {
    throw new ComparisonError(
      `Invalid rubric assessment at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function assignmentFeedbackPaths(
  courseRoot: string,
  assignmentSlug: string,
  assignmentTitle: string,
  assignmentCanvasId: string,
): Promise<readonly string[]> {
  const assignmentsRoot = join(courseRoot, vaultLayout.assignmentsDirectory)
  const matchingFolders: string[] = []
  try {
    const entries = await readdir(assignmentsRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const title = entry.name
        .replace(/^\d{4}-\d{2}-\d{2}\s+-\s+/, "")
        .replace(/^Undated\s+-\s+/i, "")
      if (
        slugify(title, "") === assignmentSlug ||
        slugify(assignmentTitle, "") === slugify(title, "")
      ) {
        matchingFolders.push(join(assignmentsRoot, entry.name, vaultLayout.feedbackFile))
      }
    }
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  const withMatchingIdentity: string[] = []
  for (const path of matchingFolders) {
    const source = await readOptional(path)
    if (source === null) continue
    try {
      const parsed = parseVaultDocument(source, path)
      if (parsed.frontmatter.canvas_id === `${assignmentCanvasId}-feedback`) {
        withMatchingIdentity.push(path)
      }
    } catch {
      // A malformed feedback document is not a safe ground-truth source.
    }
  }
  if (withMatchingIdentity.length === 1) return withMatchingIdentity
  if (withMatchingIdentity.length > 1) return []
  // When older feedback lacks the expected identity suffix, accept a unique
  // title match only; duplicate titles are ambiguous and yield no ground truth.
  if (matchingFolders.length === 1) return matchingFolders
  if (matchingFolders.length > 1) return []

  // Preserve v1 flat feedback and the transitional flat v2 compatibility path.
  return [
    join(assignmentsRoot, `${assignmentSlug}${vaultLayout.feedback}`),
    join(courseRoot, vaultLayout.assignments, `${assignmentSlug}${vaultLayout.feedback}`),
  ]
}

const nonCourseContentFiles = new Set(["_index.md", "comparison.md", "scorecard.md"])

async function weekContentCoverage(input: {
  readonly weekRoot: string
  readonly brief: string
}): Promise<readonly { readonly path: string; readonly coverage: "hit" | "missed" }[]> {
  // The course-week directory is now flat and self-contained: its own content
  // (modules/assignments/files/etc) sits directly beside the run files
  // (report.json/comparison.md/scorecard.md), so the run files must be
  // excluded explicitly rather than relying on a nested course subdirectory.
  const courseRoot = input.weekRoot
  const entries = await readdir(courseRoot, { recursive: true })
  return entries
    .filter(
      (entry) =>
        entry.endsWith(".md") && !entry.startsWith("prep/") && !nonCourseContentFiles.has(entry),
    )
    .sort()
    .map((entry) => ({
      path: entry,
      coverage: documentCovered(input.brief, relative(courseRoot, join(courseRoot, entry)))
        ? "hit"
        : "missed",
    }))
}

// Needs BOTH checks: the raw-path substring match catches a brief that quotes
// the exact vault-relative link (the common case, e.g. from a Markdown
// citation), while the all-basename-words match catches a brief that
// paraphrases the document's title in prose without ever repeating the path.
function documentCovered(brief: string, path: string): boolean {
  const words = basename(path, ".md")
    .split(/[^a-z0-9]+/i)
    .filter((word) => word.length > 2)
  return (
    normalize(brief).includes(normalize(path)) ||
    words.every((word) => normalize(brief).includes(word.toLowerCase()))
  )
}

function criterionCoverage(
  draft: string,
  criterion: string,
): "hit" | "missed" | "missed-but-flagged" {
  const label = criterionLabel(criterion)
  const normalizedDraft = normalize(draft)
  if (
    new RegExp(`\\b(?:todo|tbd|flagged|uncertain)\\b[^\\n]*${escapeRegExp(label)}`, "i").test(draft)
  ) {
    return "missed-but-flagged"
  }
  return normalizedDraft.includes(label) ? "hit" : "missed"
}

function criterionLabel(criterion: string): string {
  return criterion.replaceAll(/[-_]+/g, " ").trim().toLowerCase()
}

function normalize(value: string): string {
  return value.toLowerCase().replaceAll(/\s+/g, " ").trim()
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function renderScorecard(artifacts: readonly ComparisonArtifact[]): string {
  return [
    "# Anchored human scorecard",
    "",
    "Do not auto-score usefulness. A human chooses one anchored rating for each pre-listed artifact.",
    "",
    "- 1 — unusable without a full rewrite.",
    "- 2 — useful fragments, but substantial restructuring required.",
    "- 3 — a workable direction requiring material edits.",
    "- 4 — would have used this as my starting point with light edits.",
    "- 5 — ready to use with only trivial changes.",
    "",
    "| Artifact | Anchored 1-5 | Notes |",
    "| --- | --- | --- |",
    ...artifacts.map((artifact) => `| ${artifact.label} | 1 / 2 / 3 / 4 / 5 | |`),
    "",
  ].join("\n")
}
