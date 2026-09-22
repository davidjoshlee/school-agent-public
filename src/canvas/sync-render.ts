import type {
  Announcement,
  Assignment,
  CanvasFile,
  CanvasPage,
  Course,
  DiscussionTopic,
  Module,
  OwnSubmission,
  Quiz,
} from "./endpoints.js"
import { parseSessionDate } from "./sync-session-date.js"

export { resolveCourseYear } from "./sync-session-date.js"

export function courseUrl(baseUrl: string, courseId: string | number): string {
  return new URL(`/courses/${encodeURIComponent(String(courseId))}`, baseUrl).toString()
}

/**
 * `courseYear` — resolved once per course sync by `resolveCourseYear` — lets a
 * module title's bare month-day ("Session 8 (October 16)") become a full
 * `session_at` date. Modules commonly carry no reliable `unlock_at` (Canvas
 * modules are often left unlocked and just used for organization), so
 * `session_at` is the honest as-of-clock signal simulate/retrieve fall back
 * to instead of the bulk-setup `created_at`.
 */
export function moduleDates(
  module: Module,
  courseYear?: number,
): Readonly<Record<string, string>> | undefined {
  const dates: Record<string, string> = {}
  if (module.unlock_at !== undefined && module.unlock_at !== null) {
    dates["unlock_at"] = module.unlock_at
  }
  if (module.created_at !== undefined && module.created_at !== null) {
    dates["created_at"] = module.created_at
  }
  const sessionAt =
    module.name === undefined ? undefined : parseSessionDate(module.name, courseYear)
  if (sessionAt !== undefined) {
    dates["session_at"] = sessionAt
  }
  return Object.keys(dates).length === 0 ? undefined : dates
}

/**
 * Visibility dates for a synced file artifact.
 *
 * `visibilityDate` reads `created_at` (never `updated_at`), so a file artifact
 * must carry a readable `created_at` day to be staged. Prefer the file's own
 * creation date, falling back to `updated_at` (never predates creation, so
 * staging then is leak-safe), then to any module-level signal. Returns
 * `undefined` when no date signal exists, leaving the artifact unknown-visibility.
 */
export function fileArtifactDates(
  file: CanvasFile,
  fallback: Readonly<Record<string, string | null>> = {},
): Readonly<Record<string, string | null>> | undefined {
  const dates: Record<string, string | null> = {}
  const created = file.created_at ?? file.updated_at
  if (created !== undefined && created !== null) {
    dates["created_at"] = created
  }
  if (file.updated_at !== undefined && file.updated_at !== null) {
    dates["updated_at"] = file.updated_at
  }
  if (dates["created_at"] === undefined) {
    for (const [key, value] of Object.entries(fallback)) {
      if (value !== null && value !== undefined && dates[key] === undefined) dates[key] = value
    }
  }
  return Object.keys(dates).length === 0 ? undefined : dates
}

/**
 * Extracts every Canvas file id referenced by a `/files/<id>` URL inside a
 * block of Canvas-authored HTML (plain links, `data-api-endpoint`
 * attributes, a trailing query string, and `/download` suffixes all match).
 * Generic — used for assignment descriptions, page bodies, and the syllabus
 * body alike. Returns deduped ids in first-seen order, `[]` when there is no
 * html.
 */
export function fileIdsFromHtml(html: string | null | undefined): readonly string[] {
  if (html === null || html === undefined || html.length === 0) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const match of html.matchAll(/\/files\/(\d+)/g)) {
    const id = match[1]
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function renderSyllabus(course: Course): string {
  return course.syllabus_body ?? ""
}

export function renderModule(module: Module): string {
  const items = module.items ?? []
  return [module.name ?? `Module ${module.id}`, "", ...items.map(renderModuleItem)].join("\n")
}

export function renderAssignment(assignment: Assignment): string {
  return [
    assignment.description ?? "",
    assignment.due_at === undefined ? "" : `Due: ${assignment.due_at ?? "undated"}`,
    assignment.group_category_id === undefined || assignment.group_category_id === null
      ? ""
      : `Group category: ${assignment.group_category_id}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n\n")
}

export function renderAnnouncement(announcement: Announcement): string {
  return announcement.message ?? ""
}

export function renderPage(page: CanvasPage): string {
  return page.body ?? ""
}

export function renderDiscussion(topic: DiscussionTopic): string {
  return topic.message ?? ""
}

export function renderQuiz(quiz: Quiz): string {
  return quiz.description ?? ""
}

export function renderFeedback(submission: OwnSubmission): string {
  const feedback = [
    submission.score === undefined || submission.score === null
      ? null
      : `Score: ${submission.score}`,
    submission.graded_at === undefined || submission.graded_at === null
      ? null
      : `Graded: ${submission.graded_at}`,
    submission.rubric_assessment === undefined || submission.rubric_assessment === null
      ? null
      : `Rubric assessment:\n\n\`\`\`json\n${JSON.stringify(submission.rubric_assessment, null, 2)}\n\`\`\``,
    ...(submission.submission_comments ?? []).flatMap((comment) =>
      comment.comment === undefined ? [] : [`Instructor comment: ${comment.comment}`],
    ),
  ].filter((entry): entry is string => entry !== null)
  return feedback.join("\n\n")
}

export function hasGradedFeedback(submission: OwnSubmission): boolean {
  return (
    submission.score !== undefined ||
    submission.rubric_assessment !== undefined ||
    (submission.submission_comments ?? []).some((comment) => comment.comment !== undefined)
  )
}

/**
 * Renders one module-item line as `- <Type>: <Title> (canvas_id: <id>)` (or
 * `(page_url: <url>)` for a Page item), so downstream module-structured
 * retrieval (`retrieve-modules.ts`) can resolve the line back to the vault
 * document it describes without re-fetching Canvas. `content_id` is the
 * item's referenced Assignment/File id; Page items carry no reliable
 * `content_id` in the Canvas API, so their own `page_url` is surfaced
 * instead. Kept human-readable Markdown — never structured/JSON — and
 * backward compatible: `moduleAssignmentDocuments` still parses the older
 * title-only form for vaults synced before this change.
 */
function renderModuleItem(item: NonNullable<Module["items"]>[number]): string {
  const title = item.title ?? `Untitled item ${item.id ?? "unknown"}`
  const type = item.type ?? "Item"
  const suffix = moduleItemSuffix(item, type)
  return `- ${type}: ${title}${suffix}`
}

function moduleItemSuffix(item: NonNullable<Module["items"]>[number], type: string): string {
  if (type === "Page") {
    return item.page_url === undefined ? "" : ` (page_url: ${item.page_url})`
  }
  const id = item.content_id ?? item.id
  return id === undefined ? "" : ` (canvas_id: ${id})`
}
