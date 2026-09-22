import { randomUUID } from "node:crypto"
import { writeDueSoonReminders } from "../engines/timeline.js"
import { VaultWriter } from "../store/vault.js"
import { type Course, dedupeCoursesById, listCourses } from "./endpoints.js"
import { CanvasHttpError, TokenExpiredError } from "./http.js"
import { syncCourse } from "./sync-course.js"
import type { CanvasSyncInput, CanvasSyncReport, SyncCourseReport } from "./sync-types.js"

export type {
  CanvasSyncInput,
  CanvasSyncReport,
  SyncChange,
  SyncCourseReport,
  SyncPermissionGap,
} from "./sync-types.js"

export class CanvasSyncAuthenticationError extends Error {
  readonly name = "CanvasSyncAuthenticationError"
  readonly code = "CANVAS_SYNC_AUTHENTICATION_REQUIRED"

  constructor() {
    super(
      "Canvas authentication expired. Re-mint the token and run school auth login; see docs/auth-runbook.md.",
    )
  }
}

export async function syncCanvas(input: CanvasSyncInput): Promise<CanvasSyncReport> {
  const now = input.now ?? (() => new Date())
  const writer = new VaultWriter({ root: input.vaultPath, gitInit: input.gitInit })
  let courses: readonly Course[]
  try {
    courses = dedupeCoursesById(
      await listCourses(input.client, "active"),
      await listCourses(input.client, "completed"),
    )
  } catch (error: unknown) {
    rethrowAsAuthenticationError(error)
  }
  const selected = selectCourses(courses, input.courseIds, input.courseOverrides)
  const reports: SyncCourseReport[] = []
  for (const course of selected) {
    reports.push(await isolatedCourseSync({ input, writer, course, now }))
  }
  const report = {
    discoveredCourseIds: courses.map((course) => String(course.id)),
    courses: reports,
  }
  await writer.appendSyncLog({
    canvasUrl: input.canvasBaseUrl,
    entry: renderSyncLog(report, now()),
  })
  await writeDueSoonReminders({
    index: input.index,
    leadDays: input.leadDays ?? 7,
    now: now(),
    vault: writer,
    canvasUrl: input.canvasBaseUrl,
    ...(input.dueSoonNotifier === undefined ? {} : { notify: input.dueSoonNotifier }),
  })
  return report
}

function selectCourses(
  courses: readonly Course[],
  courseIds: readonly string[] | undefined,
  overrides: Readonly<Record<string, Course>> = {},
): readonly Course[] {
  if (courseIds === undefined || courseIds.length === 0) return courses
  const selected = new Set(courseIds)
  const matched = courses.filter(
    (course) => selected.has(String(course.id)) || selected.has(course.course_code ?? ""),
  )
  const matchedIds = new Set(matched.map((course) => String(course.id)))
  // Drop overrides that duplicate a discovered course; keep those that discovery
  // did not surface so an explicitly requested ended course is still synced.
  const overrideCourses = Object.values(overrides).filter(
    (course) => selected.has(String(course.id)) && !matchedIds.has(String(course.id)),
  )
  return [...matched, ...overrideCourses]
}

async function isolatedCourseSync(input: {
  readonly input: CanvasSyncInput
  readonly writer: VaultWriter
  readonly course: Course
  readonly now: () => Date
}): Promise<SyncCourseReport> {
  try {
    return await syncCourse({
      options: input.input,
      writer: input.writer,
      course: input.course,
      now: input.now,
    })
  } catch (error: unknown) {
    if (isAuthenticationError(error)) throw new CanvasSyncAuthenticationError()
    const courseId = String(input.course.id)
    const courseCode = input.course.course_code ?? `course-${courseId}`
    input.input.index.upsertSyncRun({
      canvasId: randomUUID(),
      courseCanvasId: courseId,
      startedAt: input.now().toISOString(),
      completedAt: input.now().toISOString(),
      status: "failed",
    })
    return {
      courseId,
      courseCode,
      status: "failed",
      changes: [],
      gaps: [],
      permissionGaps: [],
      error: errorMessage(error),
    }
  }
}

function rethrowAsAuthenticationError(error: unknown): never {
  if (isAuthenticationError(error)) throw new CanvasSyncAuthenticationError()
  throw error
}

export function isAuthenticationError(error: unknown): boolean {
  return (
    error instanceof TokenExpiredError || (error instanceof CanvasHttpError && error.status === 401)
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function renderSyncLog(report: CanvasSyncReport, completedAt: Date): string {
  const lines = [`## ${completedAt.toISOString()}`, ""]
  for (const course of report.courses) {
    lines.push(
      `- ${course.courseCode}: ${course.status}; changes=${course.changes.length}; gaps=${course.gaps.length}`,
    )
    for (const change of course.changes)
      lines.push(`  - ${change.resource} ${change.canvasId}: ${change.detail}`)
    if (course.error !== undefined) lines.push(`  - error: ${course.error}`)
  }
  return lines.join("\n")
}
