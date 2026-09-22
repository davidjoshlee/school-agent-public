/**
 * Resolves the first N teaching sessions for `dogfood --sessions <n>` from
 * the vault's Canvas module structure (never the SQLite index — mirrors
 * retrieve-modules.ts's own sourcing rule). A teaching session is a module
 * whose title matches "Session <number>"; sessions are returned ordered by
 * that number. See dogfood-sweep.ts for the runner that consumes this list
 * and dogfood-types.ts for the `DogfoodSweepSession` shape.
 */
import type { DogfoodSweepSession } from "./dogfood-types.js"
import { type CourseModule, loadCourseModules } from "./retrieve-modules.js"

const sessionNumberPattern = /\bsession\s+(\d+)\b/i

const monthNames = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const

export async function resolveDogfoodSessions(
  courseRoot: string,
  count: number,
  now: () => Date = (): Date => new Date(),
): Promise<readonly DogfoodSweepSession[]> {
  const modules = await loadCourseModules(courseRoot)
  const withNumbers = modules
    .map((module) => ({ module, sessionNumber: parseSessionNumber(module.title) }))
    .filter(
      (entry): entry is { module: CourseModule; sessionNumber: number } =>
        entry.sessionNumber !== null,
    )
    .sort((left, right) => left.sessionNumber - right.sessionNumber)
    .slice(0, count)

  return withNumbers.map(({ module, sessionNumber }) => {
    const assignmentItem = module.items.find((item) => item.type === "Assignment")
    const assignmentId = assignmentItem?.canvasId ?? null
    const assignmentDueAt = assignmentItem?.dueAt ?? null
    return {
      sessionNumber,
      title: module.title,
      weekDate: resolveWeekDate(module, modules, assignmentDueAt, now),
      assignmentId,
    }
  })
}

function parseSessionNumber(title: string): number | null {
  const match = sessionNumberPattern.exec(title)
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10)
}

function resolveWeekDate(
  module: CourseModule,
  modules: readonly CourseModule[],
  assignmentDueAt: string | null,
  now: () => Date,
): string {
  const fromFrontmatter = module.dates["session_at"] ?? module.dates["unlock_at"]
  if (fromFrontmatter !== undefined && fromFrontmatter !== null) {
    const iso = toIsoDate(fromFrontmatter)
    if (iso !== null) return iso
  }
  const parsedTitle = parseMonthDayFromTitle(module.title)
  if (parsedTitle !== null) {
    const year = inferYear(modules, assignmentDueAt, now)
    return `${year}-${pad(parsedTitle.month)}-${pad(parsedTitle.day)}`
  }
  if (assignmentDueAt !== null) {
    const iso = toIsoDate(assignmentDueAt)
    if (iso !== null) return iso
  }
  return toIsoDate(now().toISOString()) ?? now().toISOString().slice(0, 10)
}

function parseMonthDayFromTitle(
  title: string,
): { readonly month: number; readonly day: number } | null {
  const pattern = new RegExp(`\\b(${monthNames.join("|")})\\s+(\\d{1,2})\\b`, "i")
  const match = pattern.exec(title)
  if (match?.[1] === undefined || match[2] === undefined) return null
  const month = monthNames.indexOf(match[1].toLowerCase() as (typeof monthNames)[number]) + 1
  return { month, day: Number.parseInt(match[2], 10) }
}

function inferYear(
  modules: readonly CourseModule[],
  assignmentDueAt: string | null,
  now: () => Date,
): number {
  for (const module of modules) {
    const value = module.dates["session_at"] ?? module.dates["unlock_at"]
    if (value === undefined || value === null) continue
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.getUTCFullYear()
  }
  if (assignmentDueAt !== null) {
    const parsed = new Date(assignmentDueAt)
    if (!Number.isNaN(parsed.getTime())) return parsed.getUTCFullYear()
  }
  return now().getUTCFullYear()
}

function toIsoDate(value: string): string | null {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}
