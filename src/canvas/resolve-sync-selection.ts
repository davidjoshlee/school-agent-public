/**
 * Resolves the {courseIds, courseOverrides} pair to hand syncCanvas for ONE
 * explicitly requested course. A course Canvas discovery surfaces (active or
 * completed enrollment) needs no override. An ENDED course discovery won't
 * surface — enrollment "none", e.g. a past-year pilot — is probed directly
 * through its own resource endpoints and supplied as an override, so
 * syncCanvas still syncs it instead of silently selecting nothing. Shared by
 * sync-cli (the `sync` command), the dogfood sync flow, and the dogfood sweep
 * so all three treat ended courses identically.
 */
import { type Course, dedupeCoursesById, getSyllabus, listCourses } from "./endpoints.js"
import type { CanvasHttpClient } from "./http.js"
import { isAuthenticationError } from "./sync.js"

export type SyncSelection = {
  readonly courseIds: readonly string[]
  readonly courseOverrides: Readonly<Record<string, Course>> | undefined
}

export async function discoverCourses(client: CanvasHttpClient): Promise<readonly Course[]> {
  try {
    const [active, completed] = await Promise.all([
      listCourses(client, "active"),
      listCourses(client, "completed"),
    ])
    return dedupeCoursesById(active, completed)
  } catch (error: unknown) {
    if (isAuthenticationError(error)) throw error
    return []
  }
}

export async function resolveSyncSelection(
  client: CanvasHttpClient,
  requestedCourse: string,
  fallbackId?: string,
): Promise<SyncSelection> {
  const discovered = await discoverCourses(client)
  const matched = discovered.find(
    (course) => String(course.id) === requestedCourse || course.course_code === requestedCourse,
  )
  if (matched !== undefined) {
    return { courseIds: [requestedCourse], courseOverrides: undefined }
  }
  // An explicitly requested numeric id IS the probe target — that is the course
  // named. Fall back to the configured pilot only for a non-numeric code
  // discovery couldn't resolve (resolveEndedCourse needs a numeric id).
  const probeId = /^\d+$/.test(requestedCourse) ? requestedCourse : (fallbackId ?? requestedCourse)
  const override = await resolveEndedCourse(client, probeId)
  const id = String(override.id)
  return { courseIds: [id], courseOverrides: { [id]: override } }
}

async function resolveEndedCourse(client: CanvasHttpClient, id: string): Promise<Course> {
  try {
    const syllabus = await getSyllabus(client, id)
    return {
      id: syllabus.id,
      course_code: syllabus.course_code ?? `course-${id}`,
      name: syllabus.name ?? `Course ${id}`,
    }
  } catch (error: unknown) {
    if (isAuthenticationError(error)) throw error
    return { id, course_code: `course-${id}`, name: `Course ${id}` }
  }
}
