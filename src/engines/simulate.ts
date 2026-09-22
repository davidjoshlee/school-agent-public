import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, join, relative } from "node:path"

import type { AgentRunner } from "../agents/runner.js"
import type { SchoolConfig } from "../config/index.js"
import { createSchoolIndex } from "../store/db.js"
import { coursePaths } from "../store/paths.js"
import { parseVaultDocument } from "../store/vault.js"
import {
  draftAssignment,
  groupCategoryFromContent,
  parseAssignmentProvenance,
} from "./assignment.js"
import { generatePrepBrief } from "./prep.js"
import type { TriageFunction } from "./retrieve.js"
import { normalizeSimulationDraft } from "./simulate-output.js"
import {
  assignmentDocuments,
  moduleAssignmentDocuments,
  pilotSnapshot,
  type SnapshotDocument,
  stageSnapshot,
  visibilityBySignal,
  visibleDocuments,
} from "./simulate-snapshot.js"

const dayPattern = /^\d{4}-\d{2}-\d{2}$/

export type SimulationInput = {
  readonly config: SchoolConfig
  readonly weeks: string
  readonly runners: { readonly prep: AgentRunner; readonly assignment: AgentRunner }
  readonly triage: TriageFunction
  /** When set, draft only the assignments a single module references (narrow M1 gate). */
  readonly moduleCanvasId?: string
}

type WeekResult =
  | { readonly asOf: string; readonly status: "empty" }
  | {
      readonly asOf: string
      readonly status: "completed"
      readonly brief: { readonly path: string; readonly sources: readonly string[] }
      readonly drafts: readonly { readonly path: string; readonly sources: readonly string[] }[]
    }

export type SimulationResult = {
  /** One self-contained course-week directory name per completed week (e.g. "strat-101-2025-01-01"). */
  readonly runDirs: readonly string[]
  readonly unknownVisibility: number
  readonly leakageCount: number
  readonly weeks: readonly WeekResult[]
}

export class SimulationError extends Error {
  readonly name = "SimulationError"
}

export async function runSimulation(input: SimulationInput): Promise<SimulationResult> {
  const asOfDates = parseWeeks(input.weeks)
  const snapshot = await pilotSnapshot(input.config)
  const unknownVisibility = snapshot.documents.filter(
    (document) => document.visibleAt === null,
  ).length
  const bySignal = visibilityBySignal(snapshot.documents)
  const simsRoot = join(input.config.vault.path, "_simulations")
  const weeks: WeekResult[] = []
  const runDirs: string[] = []
  let leakageCount = 0

  for (const asOf of asOfDates) {
    const documents = visibleDocuments(snapshot.documents, asOf)
    if (documents.length === 0) {
      weeks.push({ asOf, status: "empty" })
      continue
    }
    const weekCourse = { ...snapshot.course, code: `${snapshot.course.code}-${asOf}` }
    const courseWeekRoot = coursePaths(simsRoot, weekCourse.code, weekCourse.canvasId).root
    await rm(courseWeekRoot, { recursive: true, force: true })
    await mkdir(courseWeekRoot, { recursive: true })
    await stageSnapshot({ ...snapshot, course: weekCourse }, documents, simsRoot)
    const index = createSchoolIndex({ path: ":memory:" })
    try {
      const configuration: SchoolConfig = {
        ...input.config,
        vault: { path: simsRoot, gitInit: false },
        index: { path: ":memory:" },
      }
      const brief = await generatePrepBrief({
        vaultRoot: simsRoot,
        config: configuration,
        course: weekCourse,
        period: { kind: "week", value: asOf },
        index,
        runner: input.runners.prep,
        triage: input.triage,
      })
      const briefSources = await sourceLinks(brief.path)
      let weekLeakage = countLeakage(briefSources, documents, asOf)
      const draftDocuments =
        input.moduleCanvasId === undefined
          ? assignmentDocuments(documents)
          : moduleAssignmentDocuments(snapshot, documents, input.moduleCanvasId)
      const drafts = await Promise.all(
        draftDocuments.map(async (document) => {
          const parsed = parseVaultDocument(document.raw, document.path)
          const draft = await draftAssignment({
            vaultRoot: simsRoot,
            config: configuration,
            course: weekCourse,
            assignment: {
              canvasId: parsed.frontmatter.canvas_id,
              title: titleFor(document.relativePath),
              canvasUrl: parsed.frontmatter.canvas_url,
              groupCategoryId: groupCategoryFromContent(parsed.content),
            },
            runner: input.runners.assignment,
            index,
            triage: input.triage,
          })
          await normalizeSimulationDraft(draft.path)
          const sources = await assignmentSources(draft.path)
          weekLeakage += countLeakage(sources, documents, asOf)
          return { path: relative(courseWeekRoot, draft.path), sources }
        }),
      )
      const week: WeekResult = {
        asOf,
        status: "completed",
        brief: { path: relative(courseWeekRoot, brief.path), sources: briefSources },
        drafts,
      }
      const report = {
        runId: basename(courseWeekRoot),
        unknownVisibility,
        leakageCount: weekLeakage,
        weeks: [week],
        visibility: { bySignal },
      }
      await writeFile(
        join(courseWeekRoot, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
      )
      weeks.push(week)
      runDirs.push(basename(courseWeekRoot))
      leakageCount += weekLeakage
    } finally {
      index.close()
    }
  }
  if (leakageCount > 0) {
    throw new SimulationError(
      `Leakage check failed: ${leakageCount} future source item(s) admitted.`,
    )
  }
  return { runDirs, unknownVisibility, leakageCount, weeks }
}

function parseWeeks(value: string): readonly string[] {
  const [start, end, extra] = value.split("..")
  if (
    start === undefined ||
    end === undefined ||
    extra !== undefined ||
    !isDay(start) ||
    !isDay(end)
  ) {
    throw new SimulationError("--weeks must be an inclusive ISO-date range: YYYY-MM-DD..YYYY-MM-DD")
  }
  if (start > end) {
    throw new SimulationError("--weeks start must not be after end")
  }
  const dates: string[] = []
  for (let current = start; current <= end; current = nextWeek(current)) {
    dates.push(current)
  }
  return dates
}

function isDay(value: string): boolean {
  return dayPattern.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
}

function nextWeek(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 7)
  return date.toISOString().slice(0, 10)
}

async function sourceLinks(path: string): Promise<readonly string[]> {
  const content = parseVaultDocument(await readFile(path, "utf8"), path).content
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1] ?? "")
}

async function assignmentSources(path: string): Promise<readonly string[]> {
  const content = await readFile(path, "utf8")
  return parseAssignmentProvenance(content).source_files
}

function countLeakage(
  sources: readonly string[],
  documents: readonly SnapshotDocument[],
  asOf: string,
): number {
  const byPath = new Map(documents.map((document) => [document.relativePath, document.visibleAt]))
  return sources.filter((source) => (byPath.get(source) ?? asOf) > asOf).length
}

function titleFor(path: string): string {
  return path.split("/").at(-1)?.replace(/\.md$/, "") ?? "assignment"
}
