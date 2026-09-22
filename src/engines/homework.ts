import type { SchoolIndex } from "../store/db.js"
import { coursePaths, slugify } from "../store/paths.js"
import { readDirectory } from "../util/fs.js"
import { buildTimeline, type TimelineItem } from "./timeline.js"

export type HomeworkRow = {
  readonly canvasId: string
  readonly title: string
  readonly courseCode: string
  readonly dueAt: string
  /** The highest existing draft version on disk for this assignment, or null when none exists. */
  readonly draftVersion: number | null
}

export type HomeworkListInput = {
  readonly index: SchoolIndex
  readonly vaultRoot: string
  readonly days: number
  readonly now: Date
  /** Course codes to include, or null to include every course in the index (auto mode). */
  readonly courseCodes: readonly string[] | null
}

export type CourseSelectionConfig = {
  readonly mode: "auto" | "list"
  readonly allowlist: readonly string[]
}

export class HomeworkError extends Error {
  readonly name = "HomeworkError"
}

/**
 * Resolves `--course <id-or-code>` (like `prep`), or falls back to
 * `courses.allowlist` (same semantics `sync` uses for course selection) when
 * absent. Returns null to mean "no filter" — every indexed course.
 */
export function resolveCourseCodes(
  index: SchoolIndex,
  courses: CourseSelectionConfig,
  courseArg: string | undefined,
): readonly string[] | null {
  if (courseArg !== undefined) {
    const course = index.courseByCanvasId(courseArg) ?? index.courseByCode(courseArg)
    if (course === null) {
      throw new HomeworkError(
        `Course not found in index: ${courseArg} (tried both Canvas course id and course code). Run school sync first.`,
      )
    }
    return [course.courseCode]
  }
  if (courses.mode !== "list") {
    return null
  }
  return courses.allowlist.map(
    (identifier) =>
      index.courseByCanvasId(identifier)?.courseCode ??
      index.courseByCode(identifier)?.courseCode ??
      identifier,
  )
}

/** Gradeable assignments due within the window, soonest-due first, with each row's draft status. */
export async function listHomework(input: HomeworkListInput): Promise<readonly HomeworkRow[]> {
  const timeline = buildTimeline({ index: input.index, weeks: input.days / 7, now: input.now })
  const allowed = input.courseCodes === null ? null : new Set(input.courseCodes)
  const items = timeline.dated
    .flatMap((day) => day.items)
    .filter(isAssignmentItem)
    .filter((item) => allowed === null || allowed.has(item.courseCode))
  const rows: HomeworkRow[] = []
  for (const item of items) {
    rows.push({
      canvasId: item.canvasId,
      title: item.title,
      courseCode: item.courseCode,
      dueAt: item.at,
      draftVersion: await existingDraftVersion(input.vaultRoot, input.index, item),
    })
  }
  return rows
}

export function renderHomework(rows: readonly HomeworkRow[], days: number): string {
  if (rows.length === 0) {
    return `Nothing due in the next ${days} day(s).`
  }
  const lines = [
    `Assignments due in the next ${days} day(s):`,
    "",
    "assignment_id\ttitle\tcourse\tdue\tdraft",
    ...rows.map((row) => {
      const draft = row.draftVersion === null ? "none" : `v${row.draftVersion}`
      return `${row.canvasId}\t${row.title}\t${row.courseCode}\t${row.dueAt}\t${draft}`
    }),
  ]
  const next = rows[0]
  if (next !== undefined) {
    lines.push("", `Run: school draft ${next.canvasId}`)
  }
  return lines.join("\n")
}

function isAssignmentItem(
  item: TimelineItem,
): item is TimelineItem & { readonly kind: "assignment" } {
  return item.kind === "assignment"
}

async function existingDraftVersion(
  vaultRoot: string,
  index: SchoolIndex,
  item: TimelineItem,
): Promise<number | null> {
  const course = index.courseByCode(item.courseCode)
  if (course === null) {
    return null
  }
  const paths = coursePaths(vaultRoot, course.courseCode, course.canvasId)
  const slug = slugify(item.title, `untitled-${item.canvasId}`)
  const entries = await readDirectory(paths.drafts)
  const hasBase = entries.some((entry) => entry.name === `${slug}.md`)
  const versionPattern = new RegExp(`^${escapeRegExp(slug)}\\.v(\\d+)\\.md$`)
  const versions = entries.flatMap((entry) => {
    const match = versionPattern.exec(entry.name)
    return match === null ? [] : [Number.parseInt(match[1] ?? "0", 10)]
  })
  if (!hasBase && versions.length === 0) {
    return null
  }
  return versions.length === 0 ? 1 : Math.max(...versions)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
