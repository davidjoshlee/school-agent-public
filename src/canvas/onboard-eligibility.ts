import {
  type Assignment,
  getOwnSubmission,
  getSyllabus,
  listAssignments,
  type OwnSubmission,
} from "./endpoints.js"
import type { CanvasHttpClient } from "./http.js"
import { isPermissionDenied } from "./http.js"
import type { DiscoveredCourse } from "./onboard.js"

const MIN_ELAPSED_HISTORY_DAYS = 14
const MS_PER_DAY = 86_400_000

export type FallbackVerdict =
  | { readonly kind: "eligible"; readonly course: DiscoveredCourse }
  | { readonly kind: "ineligible" }
  | { readonly kind: "unavailable" }

/**
 * Fallback M1-pilot eligibility rung: a course whose enrollment state is
 * unresolved (e.g. term ended, enrollment_state "none", workflow_state
 * "available") is eligible only when it is genuinely readable with >= 2 weeks of
 * elapsed assignment history AND >= 1 real graded submission (a non-null score or
 * a non-empty rubric_assessment). This is the real ground-truth evidence the M1
 * coverage-comparison needs — it is never a blind bypass. A readable course that
 * fails the bar is "ineligible"; a course whose content cannot be read is
 * "unavailable".
 */
export async function probeUnresolvedCourse(
  client: CanvasHttpClient,
  pilotCourseId: string,
): Promise<FallbackVerdict> {
  let courseCode: string | undefined
  let name: string | undefined
  try {
    const fetched = await getSyllabus(client, pilotCourseId)
    courseCode = fetched.course_code
    name = fetched.name
  } catch (error: unknown) {
    if (!isPermissionDenied(error)) {
      throw error
    }
  }
  const id = String(pilotCourseId)
  let assignments: readonly Assignment[]
  try {
    assignments = await listAssignments(client, id)
  } catch (error: unknown) {
    if (isPermissionDenied(error)) {
      return { kind: "unavailable" }
    }
    throw error
  }
  if (!hasElapsedHistory(assignments) || !(await hasGradedSubmission(client, id, assignments))) {
    return { kind: "ineligible" }
  }
  return {
    kind: "eligible",
    course: {
      id,
      code: courseCode ?? `course-${id}`,
      name: name ?? `Course ${id}`,
      enrollment: "unresolved",
    },
  }
}

function hasElapsedHistory(assignments: readonly Assignment[]): boolean {
  const timestamps: number[] = []
  for (const assignment of assignments) {
    const date = assignment.due_at ?? assignment.created_at ?? null
    if (date === null) continue
    const time = Date.parse(date)
    if (Number.isFinite(time)) timestamps.push(time)
  }
  if (timestamps.length < 2) return false
  const elapsedMs = Math.max(...timestamps) - Math.min(...timestamps)
  return elapsedMs / MS_PER_DAY >= MIN_ELAPSED_HISTORY_DAYS
}

async function hasGradedSubmission(
  client: CanvasHttpClient,
  courseId: string,
  assignments: readonly Assignment[],
): Promise<boolean> {
  for (const assignment of assignments) {
    if (assignment.id === undefined) continue
    if (await isGradedOwnSubmission(client, courseId, assignment.id)) return true
  }
  return false
}

async function isGradedOwnSubmission(
  client: CanvasHttpClient,
  courseId: string,
  assignmentId: string | number,
): Promise<boolean> {
  let submission: OwnSubmission
  try {
    submission = await getOwnSubmission(client, courseId, assignmentId)
  } catch (error: unknown) {
    if (isPermissionDenied(error)) {
      return false
    }
    throw error
  }
  if (submission.score !== null && submission.score !== undefined) return true
  return rubricAssessmentCount(submission.rubric_assessment) > 0
}

function rubricAssessmentCount(
  assessment: Readonly<Record<string, unknown>> | null | undefined,
): number {
  return assessment === null || assessment === undefined ? 0 : Object.keys(assessment).length
}
