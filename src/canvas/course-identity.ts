/** Prefer Canvas's course code, then its human-readable name, before an ID fallback. */
export function displayCourseCode(course: {
  readonly id: string | number
  readonly course_code?: string | null | undefined
  readonly name?: string | null | undefined
}): string {
  const code = course.course_code?.trim()
  if (code && !/^course-\d+$/i.test(code)) return code
  const name = course.name?.trim()
  if (name) return name
  return `course-${course.id}`
}
