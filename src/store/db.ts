import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import Database from "better-sqlite3"
import { z } from "zod"

import {
  queryCalendarEventForSession,
  queryCostSummary,
  queryCourseByCanvasId,
  queryCourseByCode,
  queryTokenUsageForReconciliation,
} from "./db-query.js"
import { currentMigrationVersion, migrateIndex } from "./db-schema.js"
import {
  type CostSummary,
  type EffectiveDueDate,
  type IndexCounts,
  type IndexedFileMetadata,
  type IndexedTimelineEntry,
  type IndexedTokenUsage,
  type ReconciliationCandidate,
  schoolIndexInputSchemas,
  schoolIndexSnapshotSchema,
} from "./db-types.js"
import {
  applyReconciledCost,
  tombstoneMissingAssignments,
  writeAnnouncement,
  writeAssignment,
  writeCalendarEvent,
  writeCourse,
  writeFile,
  writeMetadata,
  writeModule,
  writeSnapshot,
  writeSubmission,
  writeSyncRun,
  writeTokenUsage,
} from "./db-write.js"

const countSchema = z.object({ count: z.number().int().nonnegative() })
const dueDateRowSchema = z.object({
  override_exists: z.number().int().nonnegative(),
  override_due_at: z.string().nullable(),
  base_due_at: z.string().nullable(),
})
const assignmentDueDateRowSchema = z.object({ due_at: z.string().nullable() })
const assignmentDeletedRowSchema = z.object({ deleted: z.number().int().min(0).max(1) })
const metadataRowSchema = z.object({ value: z.string() })
const timelineAssignmentRowSchema = z.object({
  canvas_id: z.string(),
  course_canvas_id: z.string(),
  course_code: z.string(),
  title: z.string(),
  due_at: z.string().nullable(),
})
const timelineAnnouncementRowSchema = z.object({
  canvas_id: z.string(),
  course_canvas_id: z.string(),
  course_code: z.string(),
  title: z.string(),
  posted_at: z.string().nullable(),
})
const fileRowSchema = z.object({
  canvas_id: z.string(),
  course_canvas_id: z.string(),
  display_name: z.string().nullable(),
  url: z.string().nullable(),
  vault_path: z.string().nullable(),
})
const tokenUsageRowSchema = z.object({
  sync_run_canvas_id: z.string(),
  model: z.string(),
  function_name: z.string(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  recorded_at: z.string(),
  cached_input_tokens: z.number().int().nonnegative(),
  generation_id: z.string().nullable(),
  cost_source: z.string().nullable(),
})
const countStatements = {
  courses: "SELECT COUNT(*) AS count FROM courses",
  modules: "SELECT COUNT(*) AS count FROM modules",
  module_items: "SELECT COUNT(*) AS count FROM module_items",
  assignments: "SELECT COUNT(*) AS count FROM assignments",
  assignment_dates: "SELECT COUNT(*) AS count FROM assignment_dates",
  announcements: "SELECT COUNT(*) AS count FROM announcements",
  calendar_events: "SELECT COUNT(*) AS count FROM calendar_events",
  files: "SELECT COUNT(*) AS count FROM files",
  submissions: "SELECT COUNT(*) AS count FROM submissions",
  sync_runs: "SELECT COUNT(*) AS count FROM sync_runs",
  token_usage: "SELECT COUNT(*) AS count FROM token_usage",
  kv_meta: "SELECT COUNT(*) AS count FROM kv_meta",
} as const
type IndexTableName = keyof typeof countStatements

export type SchoolIndexOptions = { readonly path: string }

export class SchoolIndex {
  readonly #db: Database

  constructor(options: SchoolIndexOptions) {
    prepareIndexDirectory(options.path)
    this.#db = new Database(options.path)
    this.#db.pragma("journal_mode = WAL")
    migrateIndex(this.#db)
  }

  close(): void {
    this.#db.close()
  }

  migrationVersion(): number {
    return currentMigrationVersion(this.#db)
  }

  counts(): IndexCounts {
    return {
      courses: this.count("courses"),
      modules: this.count("modules"),
      moduleItems: this.count("module_items"),
      assignments: this.count("assignments"),
      assignmentDates: this.count("assignment_dates"),
      announcements: this.count("announcements"),
      calendarEvents: this.count("calendar_events"),
      files: this.count("files"),
      submissions: this.count("submissions"),
      syncRuns: this.count("sync_runs"),
      tokenUsage: this.count("token_usage"),
      kvMeta: this.count("kv_meta"),
    }
  }

  submissionCount(courseCanvasId: string): number {
    return countSchema.parse(
      this.#db
        .prepare("SELECT COUNT(*) AS count FROM submissions WHERE course_canvas_id = ?")
        .get(courseCanvasId),
    ).count
  }

  applySnapshot(input: unknown): void {
    const snapshot = schoolIndexSnapshotSchema.parse(input)
    this.#db.transaction(() => writeSnapshot(this.#db, snapshot))()
  }

  upsertCourse(input: unknown): void {
    writeCourse(this.#db, schoolIndexInputSchemas.course.parse(input))
  }

  upsertModule(input: unknown): void {
    writeModule(this.#db, schoolIndexInputSchemas.module.parse(input))
  }

  upsertAssignment(input: unknown): void {
    writeAssignment(this.#db, schoolIndexInputSchemas.assignment.parse(input))
  }

  assignmentDueAt(canvasId: string): string | null {
    const row = this.#db.prepare("SELECT due_at FROM assignments WHERE canvas_id = ?").get(canvasId)
    return row === undefined ? null : assignmentDueDateRowSchema.parse(row).due_at
  }

  courseByCode(courseCode: string) {
    return queryCourseByCode(this.#db, courseCode)
  }

  courseByCanvasId(canvasId: string) {
    return queryCourseByCanvasId(this.#db, canvasId)
  }

  assignmentDeleted(canvasId: string): boolean | null {
    const row = this.#db
      .prepare("SELECT deleted FROM assignments WHERE canvas_id = ?")
      .get(canvasId)
    return row === undefined ? null : assignmentDeletedRowSchema.parse(row).deleted === 1
  }

  tombstoneMissingAssignments(
    courseCanvasId: string,
    presentAssignmentIds: readonly string[],
  ): number {
    return tombstoneMissingAssignments(this.#db, courseCanvasId, presentAssignmentIds)
  }

  upsertAnnouncement(input: unknown): void {
    writeAnnouncement(this.#db, schoolIndexInputSchemas.announcement.parse(input))
  }

  upsertCalendarEvent(input: unknown): void {
    writeCalendarEvent(this.#db, schoolIndexInputSchemas.calendarEvent.parse(input))
  }

  calendarEventForSession(courseCanvasId: string, session: string) {
    return queryCalendarEventForSession(this.#db, courseCanvasId, session)
  }

  upsertFile(input: unknown): void {
    writeFile(this.#db, schoolIndexInputSchemas.file.parse(input))
  }

  upsertSubmission(input: unknown): void {
    writeSubmission(this.#db, schoolIndexInputSchemas.submission.parse(input))
  }

  upsertSyncRun(input: unknown): void {
    writeSyncRun(this.#db, schoolIndexInputSchemas.syncRun.parse(input))
  }

  upsertTokenUsage(input: unknown): void {
    writeTokenUsage(this.#db, schoolIndexInputSchemas.tokenUsage.parse(input))
  }

  tokenUsageForFunction(functionName: string): IndexedTokenUsage | null {
    const row = this.#db
      .prepare(
        "SELECT sync_run_canvas_id, model, function_name, input_tokens, output_tokens, cost_usd, recorded_at, cached_input_tokens, generation_id, cost_source FROM token_usage WHERE function_name = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(functionName)
    if (row === undefined) {
      return null
    }
    const usage = tokenUsageRowSchema.parse(row)
    return {
      syncRunCanvasId: usage.sync_run_canvas_id,
      model: usage.model,
      functionName: usage.function_name,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      costUsd: usage.cost_usd,
      recordedAt: usage.recorded_at,
      cachedInputTokens: usage.cached_input_tokens,
      generationId: usage.generation_id,
      costSource: usage.cost_source === "gateway" ? "gateway" : "estimate",
    }
  }

  costSummary(options: { readonly since?: string } = {}): CostSummary {
    return queryCostSummary(this.#db, options.since)
  }

  /** Candidate `token_usage` rows for `cost reconcile`: see {@link ReconciliationCandidate}. */
  tokenUsageForReconciliation(since: string): readonly ReconciliationCandidate[] {
    return queryTokenUsageForReconciliation(this.#db, since)
  }

  /** Overwrite one row's cost with the gateway's authoritative value; marks it gateway-sourced. */
  applyReconciledCost(candidate: ReconciliationCandidate, costUsd: number): void {
    applyReconciledCost(this.#db, candidate, costUsd)
  }

  setMetadata(input: unknown): void {
    writeMetadata(this.#db, schoolIndexInputSchemas.metadata.parse(input))
  }

  metadata(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM kv_meta WHERE key = ?").get(key)
    return row === undefined ? null : metadataRowSchema.parse(row).value
  }

  effectiveDueDate(assignmentCanvasId: string): EffectiveDueDate | null {
    const row = this.#db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM assignment_dates WHERE assignment_canvas_id = ? AND is_user_override = 1) AS override_exists, (SELECT due_at FROM assignment_dates WHERE assignment_canvas_id = ? AND is_user_override = 1 LIMIT 1) AS override_due_at, due_at AS base_due_at FROM assignments WHERE canvas_id = ?",
      )
      .get(assignmentCanvasId, assignmentCanvasId, assignmentCanvasId)
    if (row === undefined) {
      return null
    }
    const dueDate = dueDateRowSchema.parse(row)
    const dueAt = dueDate.override_exists === 1 ? dueDate.override_due_at : dueDate.base_due_at
    return dueAt === null ? { bucket: "undated", dueAt } : { bucket: "dated", dueAt }
  }

  timelineEntries(): readonly IndexedTimelineEntry[] {
    const assignments = z
      .array(timelineAssignmentRowSchema)
      .parse(
        this.#db
          .prepare(
            "SELECT assignments.canvas_id, assignments.course_canvas_id, COALESCE(courses.course_code, 'course-' || courses.canvas_id) AS course_code, COALESCE(assignments.name, 'Assignment ' || assignments.canvas_id) AS title, CASE WHEN EXISTS(SELECT 1 FROM assignment_dates WHERE assignment_dates.assignment_canvas_id = assignments.canvas_id AND assignment_dates.is_user_override = 1) THEN (SELECT due_at FROM assignment_dates WHERE assignment_dates.assignment_canvas_id = assignments.canvas_id AND assignment_dates.is_user_override = 1 LIMIT 1) ELSE assignments.due_at END AS due_at FROM assignments INNER JOIN courses ON courses.canvas_id = assignments.course_canvas_id WHERE assignments.deleted = 0",
          )
          .all(),
      )
      .map((assignment) => ({
        kind: "assignment" as const,
        canvasId: assignment.canvas_id,
        courseCanvasId: assignment.course_canvas_id,
        courseCode: assignment.course_code,
        title: assignment.title,
        dueAt: assignment.due_at,
      }))
    const announcements = z
      .array(timelineAnnouncementRowSchema)
      .parse(
        this.#db
          .prepare(
            "SELECT announcements.canvas_id, announcements.course_canvas_id, COALESCE(courses.course_code, 'course-' || courses.canvas_id) AS course_code, COALESCE(announcements.title, 'Announcement ' || announcements.canvas_id) AS title, announcements.posted_at FROM announcements INNER JOIN courses ON courses.canvas_id = announcements.course_canvas_id",
          )
          .all(),
      )
      .map((announcement) => ({
        kind: "announcement" as const,
        canvasId: announcement.canvas_id,
        courseCanvasId: announcement.course_canvas_id,
        courseCode: announcement.course_code,
        title: announcement.title,
        postedAt: announcement.posted_at,
      }))
    return [...assignments, ...announcements]
  }

  fileMetadata(canvasId: string): IndexedFileMetadata | null {
    const row = this.#db
      .prepare(
        "SELECT canvas_id, course_canvas_id, display_name, url, vault_path FROM files WHERE canvas_id = ?",
      )
      .get(canvasId)
    if (row === undefined) {
      return null
    }
    const file = fileRowSchema.parse(row)
    return {
      canvasId: file.canvas_id,
      courseCanvasId: file.course_canvas_id,
      displayName: file.display_name,
      url: file.url,
      vaultPath: file.vault_path,
    }
  }

  private count(table: IndexTableName): number {
    return countSchema.parse(this.#db.prepare(countStatements[table]).get()).count
  }
}

export function createSchoolIndex(options: SchoolIndexOptions): SchoolIndex {
  return new SchoolIndex(options)
}

function prepareIndexDirectory(path: string): void {
  if (path !== ":memory:" && !path.startsWith("file:")) {
    mkdirSync(dirname(path), { recursive: true })
  }
}
