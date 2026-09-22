/**
 * Orchestration core for `dogfood --sessions <n>`: loops the resolved
 * sessions (dogfood-sweep-resolve.ts) and calls `runDogfood` once per
 * session, each writing its own non-clobbering results/summary file (see
 * `dogfoodSweepPaths` in store/paths.ts), plus one aggregate index. Mirrors
 * dogfood.ts's shape: injectable `runOne`/`now`/`log`, one session's error
 * never aborts the rest. See dogfood-sweep-cli.ts for the real-engine wiring.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { dogfoodSweepPaths } from "../store/paths.js"
import { readOptional } from "../util/fs.js"
import { type RunDogfoodInput, type RunDogfoodSummary, runDogfood } from "./dogfood.js"
import type { DogfoodFlow, DogfoodSweepSession, DogfoodTarget } from "./dogfood-types.js"

export type DogfoodSweepEntry = {
  readonly session: DogfoodSweepSession
  readonly resultsPath: string
  readonly summaryPath: string
  readonly passed: number
  readonly skipped: number
  readonly total: number
  readonly failed: boolean
  readonly error?: string
}

export type DogfoodSweepIndex = {
  readonly startedAt: string
  readonly course: string
  readonly courseSlug: string
  readonly entries: readonly DogfoodSweepEntry[]
}

export type RunDogfoodSweepInput = {
  readonly course: string
  readonly courseSlug: string
  readonly vaultRoot: string
  readonly sessions: readonly DogfoodSweepSession[]
  readonly buildFlows: (session: DogfoodSweepSession) => readonly DogfoodFlow[]
  readonly fresh?: boolean
  readonly now?: () => Date
  readonly log?: (line: string) => void
  readonly runOne?: (input: RunDogfoodInput) => Promise<RunDogfoodSummary>
}

export async function runDogfoodSweep(input: RunDogfoodSweepInput): Promise<DogfoodSweepIndex> {
  const now = input.now ?? ((): Date => new Date())
  const log = input.log ?? ((line: string): void => console.log(line))
  const runOne = input.runOne ?? runDogfood
  const paths = dogfoodSweepPaths(input.vaultRoot, input.courseSlug)
  const startedAt = now().toISOString()
  const startDate = startedAt.slice(0, 10)
  const entries: DogfoodSweepEntry[] = []

  for (const session of input.sessions) {
    const resultsPath = paths.sessionResultsPath(session.sessionNumber, session.weekDate)
    const summaryPath = paths.sessionSummaryPath(session.sessionNumber, session.weekDate)
    const entry = await runOrSkipSession(input, session, resultsPath, summaryPath, runOne, now, log)
    entries.push(entry)
    await persistIndex(paths, startDate, {
      startedAt,
      course: input.course,
      courseSlug: input.courseSlug,
      entries,
    })
  }

  const index: DogfoodSweepIndex = {
    startedAt,
    course: input.course,
    courseSlug: input.courseSlug,
    entries,
  }
  await persistIndex(paths, startDate, index)
  return index
}

async function runOrSkipSession(
  input: RunDogfoodSweepInput,
  session: DogfoodSweepSession,
  resultsPath: string,
  summaryPath: string,
  runOne: (runInput: RunDogfoodInput) => Promise<RunDogfoodSummary>,
  now: () => Date,
  log: (line: string) => void,
): Promise<DogfoodSweepEntry> {
  if (input.fresh !== true && (await priorAllNotFailed(resultsPath))) {
    const prior = await readPriorCounts(resultsPath)
    log(`[skip session] session ${session.sessionNumber} (already not-failed)`)
    return { session, resultsPath, summaryPath, ...prior, failed: false }
  }
  try {
    const flows = input.buildFlows(session)
    const target: DogfoodTarget = {
      course: input.course,
      week: session.weekDate,
      assignment: session.assignmentId ?? "none",
    }
    const summary = await runOne({
      flows,
      target,
      resultsPath,
      summaryPath,
      ...(input.fresh === true ? { fresh: true } : {}),
      now,
      log,
    })
    const skipped = summary.results.flows.filter((flow) => flow.status === "skipped").length
    return {
      session,
      resultsPath,
      summaryPath,
      passed: summary.passed,
      skipped,
      total: summary.total,
      failed: summary.passed + skipped < summary.total,
    }
  } catch (error) {
    return {
      session,
      resultsPath,
      summaryPath,
      passed: 0,
      skipped: 0,
      total: 0,
      failed: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function priorAllNotFailed(resultsPath: string): Promise<boolean> {
  const flows = await readPersistedFlows(resultsPath)
  return flows !== null && flows.length > 0 && flows.every((flow) => flow.status !== "fail")
}

async function readPriorCounts(
  resultsPath: string,
): Promise<{ readonly passed: number; readonly skipped: number; readonly total: number }> {
  const flows = (await readPersistedFlows(resultsPath)) ?? []
  return {
    passed: flows.filter((flow) => flow.status === "pass").length,
    skipped: flows.filter((flow) => flow.status === "skipped").length,
    total: flows.length,
  }
}

async function readPersistedFlows(
  resultsPath: string,
): Promise<readonly { readonly status?: string }[] | null> {
  const raw = await readOptional(resultsPath)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as { flows?: readonly { readonly status?: string }[] }
    return Array.isArray(parsed.flows) ? parsed.flows : null
  } catch {
    return null
  }
}

async function persistIndex(
  paths: ReturnType<typeof dogfoodSweepPaths>,
  startDate: string,
  index: DogfoodSweepIndex,
): Promise<void> {
  const jsonPath = paths.indexPath(startDate)
  const mdPath = paths.indexSummaryPath(startDate)
  await mkdir(dirname(jsonPath), { recursive: true })
  await writeFile(jsonPath, `${JSON.stringify(index, null, 2)}\n`, "utf8")
  await writeFile(mdPath, renderSweepMarkdown(index), "utf8")
}

function renderSweepMarkdown(index: DogfoodSweepIndex): string {
  const lines = [
    "# Dogfood sweep",
    "",
    `- Started: ${index.startedAt}`,
    `- Course: ${index.course} (${index.courseSlug})`,
    `- Sessions: ${index.entries.length}`,
    "",
    "| Session | Title | Week | Assignment | Passed/Total | Skipped | Status | Results |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ]
  for (const entry of index.entries) {
    const status = entry.failed ? "FAIL" : "ok"
    const assignment = entry.session.assignmentId ?? "(prep-only)"
    lines.push(
      `| ${entry.session.sessionNumber} | ${cell(entry.session.title)} | ${entry.session.weekDate} | ${assignment} | ${entry.passed}/${entry.total} | ${entry.skipped} | ${status} | ${cell(entry.error ?? entry.resultsPath)} |`,
    )
  }
  return `${lines.join("\n")}\n`
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}
