import { createHash } from "node:crypto"
import { mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { discoverCourseSchedule } from "../canvas/course-schedule.js"
import type { CanvasHttpClient } from "../canvas/http.js"
import type { SchoolConfig } from "../config/index.js"
import { vaultPaths } from "../store/paths.js"
import { expandConfirmedMeetings } from "./meeting-recurrence.js"
import {
  planScheduledPrep,
  type ScheduledPrepJob,
  type ScheduledPrepPlan,
} from "./scheduled-prep-plan.js"

type Client = Pick<CanvasHttpClient, "paginate">
type LedgerStatus = "started" | "completed" | "failed"
type LedgerRecord = { readonly status: LedgerStatus; readonly errorSummary?: string }

export type AutoPrepRunInput = {
  readonly client: Client
  readonly config: Pick<SchoolConfig, "autoPrep">
  readonly vaultRoot: string
  readonly now: Date | string
  /** Omit or set false for a read-only preview. */
  readonly execute?: boolean
  readonly prepare: (courseId: string, weekStart: string) => Promise<void>
  readonly hasExistingPrep: (courseId: string, weekStart: string) => Promise<boolean>
}

export type AutoPrepOutcome = {
  readonly job: ScheduledPrepJob
  readonly status:
    | "would-run"
    | "completed"
    | "failed"
    | "existing-prep"
    | "already-attempted"
    | "locked"
  readonly ledgerStatus?: LedgerStatus
  readonly errorSummary?: string
  /** Inspect this file before manually clearing a failed or interrupted attempt. */
  readonly ledgerPath: string
}

export type AutoPrepRunReport = {
  readonly mode: "preview" | "execute" | "disabled"
  readonly plan: ScheduledPrepPlan
  readonly enrollmentCoverage: "available" | "permission-denied" | "not-checked"
  readonly outcomes: readonly AutoPrepOutcome[]
}

/** Generate only for confirmed configured meetings with verified enrolled standing. */
export async function runAutoPrep(input: AutoPrepRunInput): Promise<AutoPrepRunReport> {
  const emptyPlan: ScheduledPrepPlan = { jobs: [], skipped: [] }
  if (input.execute === true && !input.config.autoPrep.enabled) {
    return { mode: "disabled", plan: emptyPlan, enrollmentCoverage: "not-checked", outcomes: [] }
  }
  if (!isAbsolute(input.vaultRoot)) throw new Error("vaultRoot must be an absolute path")
  const nowMs = input.now instanceof Date ? input.now.getTime() : Date.parse(input.now)
  if (!Number.isFinite(nowMs)) throw new Error("now must be a valid instant")
  const auto = input.config.autoPrep
  const hourMs = 3_600_000
  // UTC bounds are deliberately wider than the local window at both edges.
  const fromDate = new Date(nowMs - (auto.windowHours + 48) * hourMs).toISOString().slice(0, 10)
  const throughDate = new Date(nowMs + (auto.leadHours + 48) * hourMs).toISOString().slice(0, 10)
  const meetings = expandConfirmedMeetings(auto.meetings, auto.timeZone, fromDate, throughDate)
  const courseIds = [...new Set(auto.meetings.map((rule) => rule.courseCanvasId))]
  const discovery = await discoverCourseSchedule(input.client, {
    courseIds,
    startDate: fromDate,
    endDate: throughDate,
    designations: auto.standingOverrides,
    includeCalendar: false,
  })
  // An enrollment endpoint permission gap is insufficient evidence for automatic prep.
  const standing = Object.fromEntries(
    discovery.courses.map((course) => [course.courseId, course.standing]),
  )
  if (discovery.enrollmentCoverage !== "available") {
    for (const id of courseIds) standing[id] = "unknown"
  }
  const plan = planScheduledPrep({
    meetings,
    enrollmentByCourseId: standing,
    now: input.now,
    timeZone: auto.timeZone,
    leadHours: auto.leadHours,
    windowHours: auto.windowHours,
  })
  const mode = input.execute === true ? "execute" : "preview"
  const outcomes: AutoPrepOutcome[] = []
  const ledgerDir = vaultPaths(input.vaultRoot).metadata.autoPrepLedger
  for (const job of plan.jobs) {
    const ledgerPath = join(ledgerDir, `${digest(job.idempotencyKey)}.json`)
    const current = await readLedger(ledgerPath)
    if (current !== null) {
      outcomes.push({
        job,
        status: "already-attempted",
        ledgerStatus: current.status,
        ...(current.errorSummary === undefined ? {} : { errorSummary: current.errorSummary }),
        ledgerPath,
      })
      continue
    }
    if (await input.hasExistingPrep(job.courseCanvasId, job.weekStart)) {
      outcomes.push({ job, status: "existing-prep", ledgerPath })
      continue
    }
    if (mode === "preview") {
      outcomes.push({ job, status: "would-run", ledgerPath })
      continue
    }
    await mkdir(ledgerDir, { recursive: true })
    const lockPath = `${ledgerPath}.lock`
    try {
      await mkdir(lockPath)
    } catch (error: unknown) {
      if (hasCode(error, "EEXIST")) {
        outcomes.push({ job, status: "locked", ledgerPath })
        continue
      }
      throw error
    }
    try {
      const afterLock = await readLedger(ledgerPath)
      if (afterLock !== null) {
        outcomes.push({
          job,
          status: "already-attempted",
          ledgerStatus: afterLock.status,
          ...(afterLock.errorSummary === undefined ? {} : { errorSummary: afterLock.errorSummary }),
          ledgerPath,
        })
        continue
      }
      if (await input.hasExistingPrep(job.courseCanvasId, job.weekStart)) {
        outcomes.push({ job, status: "existing-prep", ledgerPath })
        continue
      }
      await createLedger(ledgerPath, job, "started")
      try {
        await input.prepare(job.courseCanvasId, job.weekStart)
      } catch (error: unknown) {
        const errorSummary = summarizeFailure(error)
        await replaceLedger(ledgerPath, job, "failed", errorSummary)
        outcomes.push({ job, status: "failed", ledgerStatus: "failed", errorSummary, ledgerPath })
        continue
      }
      await replaceLedger(ledgerPath, job, "completed")
      outcomes.push({ job, status: "completed", ledgerStatus: "completed", ledgerPath })
    } finally {
      await rmdir(lockPath)
    }
  }
  return { mode, plan, enrollmentCoverage: discovery.enrollmentCoverage, outcomes }
}

function digest(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

async function readLedger(path: string): Promise<LedgerRecord | null> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return null
    throw error
  }
  const record: unknown = JSON.parse(content)
  if (typeof record !== "object" || record === null || !("status" in record)) {
    throw new Error(`Invalid auto prep ledger: ${path}`)
  }
  const status = record.status
  if (status !== "started" && status !== "completed" && status !== "failed") {
    throw new Error(`Invalid auto prep ledger status: ${path}`)
  }
  const errorSummary = "errorSummary" in record ? record.errorSummary : undefined
  if (errorSummary !== undefined && typeof errorSummary !== "string") {
    throw new Error(`Invalid auto prep ledger error summary: ${path}`)
  }
  return { status, ...(errorSummary === undefined ? {} : { errorSummary }) }
}

async function createLedger(
  path: string,
  job: ScheduledPrepJob,
  status: LedgerStatus,
): Promise<void> {
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify({ key: job.idempotencyKey, status, job })}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function replaceLedger(
  path: string,
  job: ScheduledPrepJob,
  status: LedgerStatus,
  errorSummary?: string,
): Promise<void> {
  const temporary = `${path}.tmp`
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(
      `${JSON.stringify({ key: job.idempotencyKey, status, job, errorSummary })}\n`,
    )
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error: unknown) {
    await unlink(temporary)
    throw error
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function summarizeFailure(error: unknown): string {
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)
      ? error.name
      : "UnknownError"
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,39}$/.test(error.code)
      ? ` (${error.code})`
      : ""
  return `Preparation failed: ${name}${code}. Inspect the ledger before manual retry.`
}
