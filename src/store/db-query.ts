import type Database from "better-sqlite3"
import { z } from "zod"

import type {
  CostSummary,
  IndexedCalendarEvent,
  IndexedCourse,
  ReconciliationCandidate,
} from "./db-types.js"

const courseRowSchema = z.object({ canvas_id: z.string(), course_code: z.string() })
const calendarEventRowSchema = z.object({
  canvas_id: z.string(),
  course_canvas_id: z.string(),
  title: z.string().nullable(),
  start_at: z.string().nullable(),
})
const costSummaryRowSchema = z.object({
  function_name: z.string(),
  model: z.string(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  cost_source: z.string(),
})
const reconciliationRowSchema = z.object({
  sync_run_canvas_id: z.string(),
  model: z.string(),
  function_name: z.string(),
  generation_id: z.string(),
})

export function queryCourseByCode(db: Database, courseCode: string): IndexedCourse | null {
  const row = db
    .prepare("SELECT canvas_id, course_code FROM courses WHERE course_code = ? LIMIT 1")
    .get(courseCode)
  if (row === undefined) {
    return null
  }
  const course = courseRowSchema.parse(row)
  return { canvasId: course.canvas_id, courseCode: course.course_code }
}

export function queryCourseByCanvasId(db: Database, canvasId: string): IndexedCourse | null {
  const row = db
    .prepare("SELECT canvas_id, course_code FROM courses WHERE canvas_id = ? LIMIT 1")
    .get(canvasId)
  if (row === undefined) {
    return null
  }
  const course = courseRowSchema.parse(row)
  return { canvasId: course.canvas_id, courseCode: course.course_code }
}

export function queryCalendarEventForSession(
  db: Database,
  courseCanvasId: string,
  session: string,
): IndexedCalendarEvent | null {
  const row = db
    .prepare(
      "SELECT canvas_id, course_canvas_id, title, start_at FROM calendar_events WHERE course_canvas_id = ? AND lower(COALESCE(title, '')) LIKE ? ORDER BY start_at LIMIT 1",
    )
    .get(courseCanvasId, `%session ${session.toLowerCase()}%`)
  if (row === undefined) {
    return null
  }
  const event = calendarEventRowSchema.parse(row)
  return {
    canvasId: event.canvas_id,
    courseCanvasId: event.course_canvas_id,
    title: event.title,
    startAt: event.start_at,
  }
}

/**
 * Grouped (function x model) totals, optionally windowed by `since` (an ISO
 * timestamp, inclusive). Rows with `recorded_at = ''` (pre-Stage-B / undated)
 * are excluded whenever `since` is given, because `'' >= since` is false for
 * any real timestamp — exactly the "undated rows drop out of month-to-date
 * windows" behavior the migration promises.
 */
export function queryCostSummary(db: Database, since: string | undefined): CostSummary {
  // `COALESCE(cost_source, 'estimate')` covers both pre-migration NULL rows
  // and any row a normal `recordModelUsage` write left NULL.
  const rows = z
    .array(costSummaryRowSchema)
    .parse(
      since === undefined
        ? db
            .prepare(
              "SELECT function_name, model, COALESCE(cost_source, 'estimate') AS cost_source, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cached_input_tokens) AS cached_input_tokens, SUM(cost_usd) AS cost_usd FROM token_usage GROUP BY function_name, model, cost_source ORDER BY function_name, model, cost_source",
            )
            .all()
        : db
            .prepare(
              "SELECT function_name, model, COALESCE(cost_source, 'estimate') AS cost_source, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cached_input_tokens) AS cached_input_tokens, SUM(cost_usd) AS cost_usd FROM token_usage WHERE recorded_at >= ? GROUP BY function_name, model, cost_source ORDER BY function_name, model, cost_source",
            )
            .all(since),
    )
  const groups = rows.map((row) => ({
    functionName: row.function_name,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    costUsd: row.cost_usd,
    costSource: row.cost_source === "gateway" ? ("gateway" as const) : ("estimate" as const),
  }))
  return {
    groups,
    totalInputTokens: groups.reduce((sum, group) => sum + group.inputTokens, 0),
    totalOutputTokens: groups.reduce((sum, group) => sum + group.outputTokens, 0),
    totalCachedInputTokens: groups.reduce((sum, group) => sum + group.cachedInputTokens, 0),
    totalCostUsd: groups.reduce((sum, group) => sum + group.costUsd, 0),
  }
}

/**
 * `token_usage` rows in `[since, now]` (recorded_at, inclusive lower bound)
 * that carry a gateway generation id — the candidate set for `cost
 * reconcile`. Rows with a NULL/empty `generation_id` (non-gateway calls, or
 * written before this field existed) are never candidates.
 */
export function queryTokenUsageForReconciliation(
  db: Database,
  since: string,
): readonly ReconciliationCandidate[] {
  const rows = z
    .array(reconciliationRowSchema)
    .parse(
      db
        .prepare(
          "SELECT sync_run_canvas_id, model, function_name, generation_id FROM token_usage WHERE generation_id IS NOT NULL AND generation_id != '' AND recorded_at >= ? ORDER BY recorded_at",
        )
        .all(since),
    )
  return rows.map((row) => ({
    syncRunCanvasId: row.sync_run_canvas_id,
    model: row.model,
    functionName: row.function_name,
    generationId: row.generation_id,
  }))
}
