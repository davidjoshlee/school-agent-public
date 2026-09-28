import { z } from "zod"

import type { CanvasHttpClient } from "./http.js"
import { isPermissionDenied } from "./http.js"

const idSchema = z.union([z.string(), z.number()])
const enrollmentSchema = z.object({
  course_id: idSchema,
  enrollment_state: z.string(),
  type: z.string().optional(),
})
const eventSchema = z.object({
  id: idSchema,
  title: z.string(),
  start_at: z.string(),
  end_at: z.string(),
  context_code: z.string().optional(),
  effective_context_code: z.string().nullable().optional(),
  workflow_state: z.string().optional(),
  all_day: z.boolean().optional(),
  hidden: z.boolean().optional(),
  blackout_date: z.boolean().optional(),
  appointment_group_id: idSchema.nullable().optional(),
  child_events_count: z.number().int().nonnegative().optional(),
})

export type CourseStanding = "enrolled" | "waitlisted" | "old" | "unknown"
export type StandingEvidence = {
  readonly courseId: string
  readonly standing: CourseStanding
  readonly source: "canvas-enrollment" | "user-designation" | "unresolved"
  readonly enrollmentStates: readonly string[]
}
export type CalendarMeetingCandidate = {
  readonly id: string
  readonly courseId: string
  readonly title: string
  readonly startAt: string
  readonly endAt: string
}
export type CourseScheduleDiscovery = {
  readonly courses: readonly StandingEvidence[]
  /** Calendar entries are candidates, not verified class meetings. */
  readonly events: readonly CalendarMeetingCandidate[]
  readonly coverage: "canvas-calendar-only"
  readonly enrollmentCoverage: "available" | "permission-denied"
  readonly calendarCoverage: Readonly<
    Record<string, "queried" | "permission-denied" | "not-queried">
  >
  readonly skippedCalendarEvents: number
}
export type CourseScheduleInput = {
  readonly courseIds: readonly string[]
  readonly startDate: string
  readonly endDate: string
  /** An explicit user choice can identify a registrar waitlist absent from Canvas. */
  readonly designations?: Readonly<Record<string, CourseStanding>>
  /** Set false when only enrollment standing is needed. */
  readonly includeCalendar?: boolean
}

type ReadClient = Pick<CanvasHttpClient, "paginate">

const enrollmentStates = [
  "active",
  "invited",
  "creation_pending",
  "completed",
  "inactive",
  "rejected",
] as const

/** A conflicting or unsupported enrollment state never enables autonomous prep. */
export function classifyCourseStanding(
  courseId: string,
  enrollments: readonly z.infer<typeof enrollmentSchema>[],
  designation?: CourseStanding,
): StandingEvidence {
  const states = [
    ...new Set(
      enrollments
        .filter((entry) => String(entry.course_id) === courseId)
        .filter((entry) => entry.type === undefined || entry.type === "StudentEnrollment")
        .map((entry) => entry.enrollment_state.toLowerCase()),
    ),
  ].sort()
  if (designation !== undefined && designation !== "unknown") {
    return { courseId, standing: designation, source: "user-designation", enrollmentStates: states }
  }
  let standing: CourseStanding = "unknown"
  if (states.length === 1) {
    if (states[0] === "active") standing = "enrolled"
    else if (states[0] === "completed") standing = "old"
    else if (states[0] === "waitlisted" || states[0] === "waitlist") standing = "waitlisted"
  }
  return {
    courseId,
    standing,
    source: standing === "unknown" ? "unresolved" : "canvas-enrollment",
    enrollmentStates: states,
  }
}

export async function discoverCourseSchedule(
  client: ReadClient,
  input: CourseScheduleInput,
): Promise<CourseScheduleDiscovery> {
  if (!validDate(input.startDate) || !validDate(input.endDate) || input.startDate > input.endDate) {
    throw new Error("Schedule window must contain valid YYYY-MM-DD dates in order")
  }
  const ids = [...new Set(input.courseIds)]
  const enrollmentQuery = new URLSearchParams()
  for (const state of enrollmentStates) enrollmentQuery.append("state[]", state)
  let enrollments: z.infer<typeof enrollmentSchema>[] = []
  let enrollmentCoverage: CourseScheduleDiscovery["enrollmentCoverage"] = "available"
  try {
    enrollments = await collect(
      client,
      `/api/v1/users/self/enrollments?${enrollmentQuery}`,
      enrollmentSchema,
    )
  } catch (error: unknown) {
    if (!isPermissionDenied(error)) throw error
    enrollmentCoverage = "permission-denied"
  }
  const courses = ids.map((id) => classifyCourseStanding(id, enrollments, input.designations?.[id]))
  const events: CalendarMeetingCandidate[] = []
  let skippedCalendarEvents = 0
  const calendarCoverage: Record<string, "queried" | "permission-denied" | "not-queried"> = {}
  for (const course of courses) {
    if (course.standing !== "enrolled" || input.includeCalendar === false) {
      calendarCoverage[course.courseId] = "not-queried"
      continue
    }
    const query = new URLSearchParams({
      type: "event",
      start_date: input.startDate,
      end_date: input.endDate,
    })
    query.append("context_codes[]", `course_${course.courseId}`)
    const eventStart = events.length
    try {
      for await (const response of client.paginate(`/api/v1/calendar_events?${query}`)) {
        const page = z.array(z.unknown()).parse(await response.json())
        for (const raw of page) {
          const parsed = eventSchema.safeParse(raw)
          if (!parsed.success) {
            skippedCalendarEvents++
            continue
          }
          const event = parsed.data
          const context = `course_${course.courseId}`
          if (
            (event.context_code !== context && event.effective_context_code !== context) ||
            event.workflow_state === "deleted" ||
            event.hidden === true ||
            event.all_day === true ||
            event.blackout_date === true ||
            event.appointment_group_id != null ||
            (event.child_events_count ?? 0) > 0 ||
            event.title.trim() === "" ||
            !validTimestamp(event.start_at) ||
            !validTimestamp(event.end_at) ||
            Date.parse(event.end_at) <= Date.parse(event.start_at)
          ) {
            skippedCalendarEvents++
            continue
          }
          events.push({
            id: String(event.id),
            courseId: course.courseId,
            title: event.title,
            startAt: event.start_at,
            endAt: event.end_at,
          })
        }
      }
      calendarCoverage[course.courseId] = "queried"
    } catch (error: unknown) {
      if (!isPermissionDenied(error)) throw error
      events.length = eventStart
      calendarCoverage[course.courseId] = "permission-denied"
    }
  }
  events.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id))
  return {
    courses,
    events,
    coverage: "canvas-calendar-only",
    enrollmentCoverage,
    calendarCoverage,
    skippedCalendarEvents,
  }
}

async function collect<T>(client: ReadClient, path: string, schema: z.ZodType<T>): Promise<T[]> {
  const result: T[] = []
  for await (const response of client.paginate(path)) {
    result.push(...z.array(schema).parse(await response.json()))
  }
  return result
}

function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  )
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && Number.isFinite(Date.parse(value))
}
