import type Database from "better-sqlite3"

import type {
  AnnouncementInput,
  AssignmentInput,
  CalendarEventInput,
  CourseInput,
  FileInput,
  MetadataInput,
  ModuleInput,
  SchoolIndexSnapshot,
  SubmissionInput,
  SyncRunInput,
  TokenUsageInput,
} from "./db-types.js"

export function writeSnapshot(db: Database, snapshot: SchoolIndexSnapshot): void {
  writeCourse(db, snapshot.course)
  for (const module of snapshot.modules) writeModule(db, module)
  for (const assignment of snapshot.assignments) writeAssignment(db, assignment)
  for (const announcement of snapshot.announcements) writeAnnouncement(db, announcement)
  for (const calendarEvent of snapshot.calendarEvents) writeCalendarEvent(db, calendarEvent)
  for (const file of snapshot.files) writeFile(db, file)
  for (const submission of snapshot.submissions) writeSubmission(db, submission)
  writeSyncRun(db, snapshot.syncRun)
  for (const usage of snapshot.tokenUsage) writeTokenUsage(db, usage)
  for (const metadata of snapshot.metadata) writeMetadata(db, metadata)
}

export function writeCourse(db: Database, course: CourseInput): void {
  db.prepare(
    "INSERT INTO courses (canvas_id, name, course_code, workflow_state, vault_path) VALUES (?, ?, ?, ?, ?) ON CONFLICT(canvas_id) DO UPDATE SET name = excluded.name, course_code = excluded.course_code, workflow_state = excluded.workflow_state, vault_path = excluded.vault_path",
  ).run(course.canvasId, course.name, course.courseCode, course.workflowState, course.vaultPath)
}

export function writeModule(db: Database, module: ModuleInput): void {
  db.prepare(
    "INSERT INTO modules (canvas_id, course_canvas_id, name, position, vault_path) VALUES (?, ?, ?, ?, ?) ON CONFLICT(canvas_id) DO UPDATE SET course_canvas_id = excluded.course_canvas_id, name = excluded.name, position = excluded.position, vault_path = excluded.vault_path",
  ).run(module.canvasId, module.courseCanvasId, module.name, module.position, module.vaultPath)
  for (const item of module.items) {
    db.prepare(
      "INSERT INTO module_items (canvas_id, module_canvas_id, course_canvas_id, title, item_type, content_canvas_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(canvas_id) DO UPDATE SET module_canvas_id = excluded.module_canvas_id, course_canvas_id = excluded.course_canvas_id, title = excluded.title, item_type = excluded.item_type, content_canvas_id = excluded.content_canvas_id",
    ).run(
      item.canvasId,
      module.canvasId,
      module.courseCanvasId,
      item.title,
      item.itemType,
      item.contentCanvasId,
    )
  }
}

export function writeAssignment(db: Database, assignment: AssignmentInput): void {
  db.prepare(
    "INSERT INTO assignments (canvas_id, course_canvas_id, name, due_at, vault_path, deleted) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(canvas_id) DO UPDATE SET course_canvas_id = excluded.course_canvas_id, name = excluded.name, due_at = excluded.due_at, vault_path = excluded.vault_path, deleted = excluded.deleted",
  ).run(
    assignment.canvasId,
    assignment.courseCanvasId,
    assignment.name,
    assignment.dueAt,
    assignment.vaultPath,
    Number(assignment.deleted),
  )
  for (const date of assignment.allDates) {
    db.prepare(
      "INSERT INTO assignment_dates (canvas_id, assignment_canvas_id, due_at, is_user_override) VALUES (?, ?, ?, ?) ON CONFLICT(canvas_id) DO UPDATE SET assignment_canvas_id = excluded.assignment_canvas_id, due_at = excluded.due_at, is_user_override = excluded.is_user_override",
    ).run(date.canvasId, assignment.canvasId, date.dueAt, Number(date.isUserOverride))
  }
}

export function tombstoneMissingAssignments(
  db: Database,
  courseCanvasId: string,
  presentAssignmentIds: readonly string[],
): number {
  if (presentAssignmentIds.length === 0) {
    return db
      .prepare("UPDATE assignments SET deleted = 1 WHERE course_canvas_id = ? AND deleted = 0")
      .run(courseCanvasId).changes
  }
  const placeholders = presentAssignmentIds.map(() => "?").join(", ")
  return db
    .prepare(
      `UPDATE assignments SET deleted = 1 WHERE course_canvas_id = ? AND deleted = 0 AND canvas_id NOT IN (${placeholders})`,
    )
    .run(courseCanvasId, ...presentAssignmentIds).changes
}

export function writeAnnouncement(db: Database, announcement: AnnouncementInput): void {
  db.prepare(
    "INSERT INTO announcements (canvas_id, course_canvas_id, title, posted_at, vault_path) VALUES (?, ?, ?, ?, ?) ON CONFLICT(canvas_id) DO UPDATE SET course_canvas_id = excluded.course_canvas_id, title = excluded.title, posted_at = excluded.posted_at, vault_path = excluded.vault_path",
  ).run(
    announcement.canvasId,
    announcement.courseCanvasId,
    announcement.title,
    announcement.postedAt,
    announcement.vaultPath,
  )
}

export function writeCalendarEvent(db: Database, calendarEvent: CalendarEventInput): void {
  db.prepare(
    "INSERT INTO calendar_events (canvas_id, course_canvas_id, title, start_at) VALUES (?, ?, ?, ?) ON CONFLICT(canvas_id) DO UPDATE SET course_canvas_id = excluded.course_canvas_id, title = excluded.title, start_at = excluded.start_at",
  ).run(
    calendarEvent.canvasId,
    calendarEvent.courseCanvasId,
    calendarEvent.title,
    calendarEvent.startAt,
  )
}

export function writeFile(db: Database, file: FileInput): void {
  db.prepare(
    "INSERT INTO files (canvas_id, course_canvas_id, display_name, url, vault_path) VALUES (?, ?, ?, ?, ?) ON CONFLICT(canvas_id) DO UPDATE SET course_canvas_id = excluded.course_canvas_id, display_name = excluded.display_name, url = excluded.url, vault_path = excluded.vault_path",
  ).run(file.canvasId, file.courseCanvasId, file.displayName, file.url, file.vaultPath)
}

export function writeSubmission(db: Database, submission: SubmissionInput): void {
  db.prepare(
    "INSERT INTO submissions (canvas_id, assignment_canvas_id, course_canvas_id, workflow_state, submitted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(canvas_id) DO UPDATE SET assignment_canvas_id = excluded.assignment_canvas_id, course_canvas_id = excluded.course_canvas_id, workflow_state = excluded.workflow_state, submitted_at = excluded.submitted_at",
  ).run(
    submission.canvasId,
    submission.assignmentCanvasId,
    submission.courseCanvasId,
    submission.workflowState,
    submission.submittedAt,
  )
}

export function writeSyncRun(db: Database, syncRun: SyncRunInput): void {
  db.prepare(
    "INSERT INTO sync_runs (canvas_id, course_canvas_id, started_at, completed_at, status) VALUES (?, ?, ?, ?, ?) ON CONFLICT(canvas_id) DO UPDATE SET course_canvas_id = excluded.course_canvas_id, started_at = excluded.started_at, completed_at = excluded.completed_at, status = excluded.status",
  ).run(
    syncRun.canvasId,
    syncRun.courseCanvasId,
    syncRun.startedAt,
    syncRun.completedAt,
    syncRun.status,
  )
}

export function writeTokenUsage(db: Database, usage: TokenUsageInput): void {
  db.prepare(
    "INSERT INTO token_usage (sync_run_canvas_id, model, function_name, input_tokens, output_tokens, cost_usd, recorded_at, cached_input_tokens, generation_id, cost_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sync_run_canvas_id, model, function_name) DO UPDATE SET input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cost_usd = excluded.cost_usd, recorded_at = excluded.recorded_at, cached_input_tokens = excluded.cached_input_tokens, generation_id = excluded.generation_id, cost_source = excluded.cost_source",
  ).run(
    usage.syncRunCanvasId,
    usage.model,
    usage.functionName,
    usage.inputTokens,
    usage.outputTokens,
    usage.costUsd,
    usage.recordedAt,
    usage.cachedInputTokens,
    usage.generationId,
    usage.costSource,
  )
}

/**
 * `cost reconcile`'s write path: overwrite one row's cost with the AI
 * Gateway's authoritative `totalCost` and mark it gateway-sourced, without
 * touching token counts or `generation_id`. Scoped to the token_usage PK.
 */
export function applyReconciledCost(
  db: Database,
  key: { readonly syncRunCanvasId: string; readonly model: string; readonly functionName: string },
  costUsd: number,
): void {
  db.prepare(
    "UPDATE token_usage SET cost_usd = ?, cost_source = 'gateway' WHERE sync_run_canvas_id = ? AND model = ? AND function_name = ?",
  ).run(costUsd, key.syncRunCanvasId, key.model, key.functionName)
}

export function writeMetadata(db: Database, metadata: MetadataInput): void {
  db.prepare(
    "INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(metadata.key, metadata.value)
}
