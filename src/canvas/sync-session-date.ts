const monthNumbers: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}

/**
 * Parses a session date out of a module title such as "Session 8 (October
 * 16)", "Oct 16", or "10/16". Deterministic: when the title carries more
 * than one candidate date and they disagree, or `courseYear` cannot be
 * resolved, this returns `undefined` rather than guessing.
 */
export function parseSessionDate(
  title: string,
  courseYear: number | undefined,
): string | undefined {
  if (courseYear === undefined) return undefined
  const candidates = new Set<string>()
  for (const match of title.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})\b/g)) {
    const month = monthNumbers[(match[1] ?? "").toLowerCase()]
    const day = Number(match[2])
    if (month !== undefined && day >= 1 && day <= 31) {
      candidates.add(isoDate(courseYear, month, day))
    }
  }
  for (const match of title.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)) {
    const month = Number(match[1])
    const day = Number(match[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      candidates.add(isoDate(courseYear, month, day))
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

export type CourseYearInput = {
  readonly course_code?: string | null | undefined
  readonly term?: { readonly start_at?: string | null | undefined } | null | undefined
  readonly start_at?: string | null | undefined
  readonly end_at?: string | null | undefined
}

/**
 * Resolves the calendar year a course's module `session_at` dates should
 * assume. Prefers the Canvas-reported term/course start, falling back to the
 * strict-majority year among assignment `due_at`s (a course spanning a
 * single term almost always clusters around one year); ties or no data at
 * all leave the year unresolved so `session_at` is simply omitted rather
 * than guessed.
 */
export function resolveCourseYear(
  course: CourseYearInput,
  assignmentDueAts: readonly (string | null | undefined)[],
): number | undefined {
  const explicit = course.term?.start_at ?? course.start_at ?? course.end_at
  if (explicit !== undefined && explicit !== null) {
    const year = new Date(explicit).getUTCFullYear()
    if (Number.isFinite(year)) return year
  }
  const codeYear = courseCodeYear(course.course_code)
  if (codeYear !== undefined) return codeYear
  const counts = new Map<number, number>()
  for (const dueAt of assignmentDueAts) {
    if (dueAt === undefined || dueAt === null) continue
    const year = new Date(dueAt).getUTCFullYear()
    if (!Number.isFinite(year)) continue
    counts.set(year, (counts.get(year) ?? 0) + 1)
  }
  if (counts.size === 0) return undefined
  const max = Math.max(...counts.values())
  const majority = [...counts.entries()].filter(([, count]) => count === max)
  return majority.length === 1 ? majority[0]?.[0] : undefined
}

function courseCodeYear(code: string | null | undefined): number | undefined {
  if (code === undefined || code === null) return undefined
  const leadingTerm = /(?:^|[-_])(?:f|w|sp|su)(\d{2})(?:[-_]|$)/i.exec(code)?.[1]
  const leadingYear = /(?:^|[-_])(\d{2})(?:f|w|sp|su)(?:[-_]|$)/i.exec(code)?.[1]
  const value = leadingTerm ?? leadingYear
  return value === undefined ? undefined : 2000 + Number.parseInt(value, 10)
}
