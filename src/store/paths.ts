import { join, parse } from "node:path"

/**
 * The path module is the layout seam for the vault. Callers should ask this
 * module for a course, period, or assignment path rather than assembling
 * layout names themselves. The implementation deliberately keeps the Canvas
 * vocabulary (frontmatter kinds and legacy paths) separate from the
 * human-facing v2 vocabulary (Week, Prep, Materials, ...).
 */
export const vaultLayout = {
  version: 2,

  // Operational vault paths. `_meta` is intentionally not course material.
  metadata: "_meta",
  syncLog: "sync-log.md",
  auth: "auth.json",
  alert: "ALERT.md",
  contextLog: "model-context-log.jsonl",
  layoutMetadata: "layout.json",
  dogfood: "dogfood",
  coursePlaybook: "course-playbook.md",

  // Human-facing v2 course tree.
  home: "00 Home.md",
  overview: "00 Overview.md",
  prompt: "00 Prompt.md",
  assignmentsIndex: "00 Assignments.md",
  assignmentsDirectory: "Assignments",
  syllabusFile: "Syllabus.md",
  resources: "Resources",
  other: "Other",
  prepDirectory: "Prep",
  materials: "Materials",
  draftsDirectory: "Drafts",
  finalDirectory: "Final",
  feedbackFile: "Feedback.md",
  guidanceDirectory: "Guidance",
  announcementsDirectory: "Announcements",
  filesDirectory: "Files",

  // Stable frontmatter kinds and v1 path names. They remain exported so a
  // migration can recognize old documents without teaching callers about
  // the old tree. Do not use these as v2 human-facing directory names.
  syllabus: "00-syllabus.md",
  index: "_index.md",
  modules: "modules",
  assignments: "assignments",
  announcements: "announcements",
  files: "files",
  prep: "prep",
  guidance: "guidance",
  guidanceProposal: "prep-guidance.proposed.md",
  drafts: "drafts",
  final: "final",
  feedback: ".feedback.md",

  markdownExtension: ".md",
  canvasUpdate: ".canvas-update",
  iCloudStub: ".icloud",
} as const

/** Frontmatter values are kept stable across the tree migration. */
export const vaultDocumentKinds = {
  syllabus: vaultLayout.syllabus,
  module: vaultLayout.modules,
  assignment: vaultLayout.assignments,
  announcement: vaultLayout.announcements,
  file: vaultLayout.files,
  prep: vaultLayout.prep,
  guidance: vaultLayout.guidance,
  draft: vaultLayout.drafts,
  final: vaultLayout.final,
  feedback: vaultLayout.feedback,
  playbook: vaultLayout.coursePlaybook,
} as const

export type VaultDocumentKind = (typeof vaultDocumentKinds)[keyof typeof vaultDocumentKinds]

/**
 * All names that belong to the layout authority. Tests use this list to catch
 * a caller sneaking a literal layout segment into a `join()` call.
 */
export const layoutSegments = [
  vaultLayout.metadata,
  vaultLayout.syncLog,
  vaultLayout.auth,
  vaultLayout.alert,
  vaultLayout.contextLog,
  vaultLayout.layoutMetadata,
  vaultLayout.dogfood,
  vaultLayout.coursePlaybook,
  vaultLayout.home,
  vaultLayout.overview,
  vaultLayout.prompt,
  vaultLayout.assignmentsIndex,
  vaultLayout.assignmentsDirectory,
  vaultLayout.syllabusFile,
  vaultLayout.resources,
  vaultLayout.other,
  vaultLayout.prepDirectory,
  vaultLayout.materials,
  vaultLayout.draftsDirectory,
  vaultLayout.finalDirectory,
  vaultLayout.feedbackFile,
  vaultLayout.guidanceDirectory,
  vaultLayout.announcementsDirectory,
  vaultLayout.filesDirectory,
  vaultLayout.syllabus,
  vaultLayout.index,
  vaultLayout.modules,
  vaultLayout.assignments,
  vaultLayout.announcements,
  vaultLayout.files,
  vaultLayout.prep,
  vaultLayout.guidance,
  vaultLayout.guidanceProposal,
  vaultLayout.drafts,
  vaultLayout.final,
  vaultLayout.feedback,
] as const

export type VaultPaths = {
  readonly root: string
  readonly metadata: {
    readonly directory: string
    readonly layout: string
    readonly syncLog: string
    readonly auth: string
    readonly alert: string
    readonly contextLog: string
  }
}

export type LegacyCoursePaths = {
  readonly root: string
  readonly syllabus: string
  readonly index: string
  readonly modules: string
  readonly assignments: string
  readonly announcements: string
  readonly files: string
  readonly prep: string
  readonly guidance: string
  readonly guidanceProposal: string
  readonly drafts: string
  readonly final: string
  readonly playbook: string
}

export type CoursePaths = {
  readonly root: string

  /** Human-facing landing page. */
  readonly home: string
  /** Machine manifest retained during incremental migration. */
  readonly index: string
  readonly syllabus: string
  readonly resources: string
  readonly other: string
  readonly assignments: string
  readonly assignmentsIndex: string

  /**
   * Compatibility path aliases. New writers should route documents through
   * periodPaths()/assignmentPaths(); these fields point at sensible v2
   * buckets so older callers can migrate one artifact kind at a time.
   */
  readonly modules: string
  readonly announcements: string
  readonly files: string
  readonly prep: string
  readonly guidance: string
  readonly guidanceProposal: string
  readonly drafts: string
  readonly final: string
  readonly playbook: string

  /** Exact v1 paths, useful to migration and compatibility adapters. */
  readonly legacy: LegacyCoursePaths
}

export type CalendarValue = string | Date
export type PeriodKind = "week" | "milestone"

export type CoursePeriodRequest = {
  readonly kind?: PeriodKind
  readonly number: number
  /** The calendar day shown in a Week folder, e.g. 2026-09-21. */
  readonly date?: CalendarValue | null
  /** Optional human label for a milestone. */
  readonly title?: string
}

export type CoursePeriodPaths = {
  readonly root: string
  readonly directory: string
  readonly overview: string
  readonly prep: string
  readonly materials: string
  readonly other: string
}

export type AssignmentPathRequest = {
  readonly title: string
  /** Due date is used for navigation only; it is never written into metadata here. */
  readonly dueAt?: CalendarValue | null
  /** Alias accepted by adapters that call the field simply `date`. */
  readonly date?: CalendarValue | null
}

export type AssignmentPaths = {
  readonly root: string
  readonly directory: string
  readonly prompt: string
  readonly materials: string
  readonly drafts: string
  readonly final: string
  readonly feedback: string
}

export type VaultPathRequest = {
  readonly kind: VaultDocumentKind
  readonly title: string
  readonly canvasId: string | number
  readonly module?: {
    readonly number: number
    readonly title: string
    /** The containing Canvas module identity, never the module item identity. */
    readonly canvasId?: string | number
    readonly kind?: PeriodKind
    readonly date?: CalendarValue | null
  }
  /** New v2 period placement, preferred over the legacy `module` shape. */
  readonly period?: CoursePeriodRequest
  /** Assignment placement for prompt/draft/final/feedback artifacts. */
  readonly assignment?: AssignmentPathRequest
  /** Canvas module that contains an item. */
  readonly moduleCanvasId?: string | number
  /** Explicit v2 bucket for a module/resource artifact. */
  readonly bucket?: "prep" | "materials" | "other"
  /** Opt into the compatibility path implementation for one caller. */
  readonly layout?: "v1" | "v2"
}

export function vaultPaths(root: string): VaultPaths {
  const metadata = join(root, vaultLayout.metadata)
  return {
    root,
    metadata: {
      directory: metadata,
      layout: join(metadata, vaultLayout.layoutMetadata),
      syncLog: join(metadata, vaultLayout.syncLog),
      auth: join(metadata, vaultLayout.auth),
      alert: join(metadata, vaultLayout.alert),
      contextLog: join(metadata, vaultLayout.contextLog),
    },
  }
}

/**
 * Return the v2 human-facing course tree. The Canvas course ID is part of
 * the root identity so cross-listed or duplicated course codes cannot share
 * one vault directory. This function only computes
 * strings; it never creates directories. Writers create a period or an
 * assignment subtree only when they have an artifact to place in it.
 */
export function coursePaths(
  root: string,
  courseCode: string,
  courseId: string | number,
): CoursePaths {
  const course = join(root, `course-${slugify(String(courseId), "unknown")}`)
  const metadata = join(course, vaultLayout.metadata)
  const legacy = legacyCoursePaths(root, courseCode, courseId)
  const resources = join(course, vaultLayout.resources)
  const other = join(course, vaultLayout.other)
  const assignments = join(course, vaultLayout.assignmentsDirectory)

  return {
    root: course,
    home: join(course, vaultLayout.home),
    index: join(course, vaultLayout.index),
    syllabus: join(resources, vaultLayout.syllabusFile),
    resources,
    other,
    assignments,
    assignmentsIndex: join(assignments, vaultLayout.assignmentsIndex),

    // These aliases make migration incremental. They are not a statement
    // that v2 should recreate v1's flat directories.
    modules: legacy.modules,
    announcements: join(other, vaultLayout.announcementsDirectory),
    files: join(resources, vaultLayout.filesDirectory),
    prep: join(other, vaultLayout.prepDirectory),
    guidance: join(resources, vaultLayout.guidanceDirectory),
    guidanceProposal: join(resources, vaultLayout.guidanceDirectory, vaultLayout.guidanceProposal),
    drafts: join(assignments, vaultLayout.draftsDirectory),
    final: join(assignments, vaultLayout.finalDirectory),
    playbook: join(metadata, vaultLayout.coursePlaybook),
    legacy,
  }
}

/** Compute the old flat tree without changing the v2 default. */
export function legacyCoursePaths(
  root: string,
  courseCode: string,
  courseId: string | number,
): LegacyCoursePaths {
  const course = join(root, slugify(courseCode, `untitled-${courseId}`))
  const metadata = join(course, vaultLayout.metadata)
  return {
    root: course,
    syllabus: join(course, vaultLayout.syllabus),
    index: join(course, vaultLayout.index),
    modules: join(course, vaultLayout.modules),
    assignments: join(course, vaultLayout.assignments),
    announcements: join(course, vaultLayout.announcements),
    files: join(course, vaultLayout.files),
    prep: join(course, vaultLayout.prep),
    guidance: join(course, vaultLayout.guidance),
    guidanceProposal: join(course, vaultLayout.guidance, vaultLayout.guidanceProposal),
    drafts: join(course, vaultLayout.drafts),
    final: join(course, vaultLayout.final),
    playbook: join(metadata, vaultLayout.coursePlaybook),
  }
}

export function periodPaths(course: CoursePaths, request: CoursePeriodRequest): CoursePeriodPaths {
  const directory = periodDirectory(course, request)
  return {
    root: directory,
    directory,
    overview: join(directory, vaultLayout.overview),
    prep: join(directory, vaultLayout.prepDirectory),
    materials: join(directory, vaultLayout.materials),
    other: join(directory, vaultLayout.other),
  }
}

/** Week helper accepting either a number plus date or a complete request. */
export function weekPaths(
  course: CoursePaths,
  numberOrRequest: number | Omit<CoursePeriodRequest, "kind">,
  date?: CalendarValue | null,
): CoursePeriodPaths {
  const request =
    typeof numberOrRequest === "number"
      ? { number: numberOrRequest, ...(date === undefined ? {} : { date }) }
      : numberOrRequest
  return periodPaths(course, { ...request, kind: "week" })
}

/** Milestone helper accepting either a number plus title or a complete request. */
export function milestonePaths(
  course: CoursePaths,
  numberOrRequest: number | Omit<CoursePeriodRequest, "kind">,
  title?: string,
): CoursePeriodPaths {
  const request =
    typeof numberOrRequest === "number"
      ? { number: numberOrRequest, ...(title === undefined ? {} : { title }) }
      : numberOrRequest
  return periodPaths(course, { ...request, kind: "milestone" })
}

/** Names a chronological container without exposing a Canvas identity. */
export function periodDirectory(course: CoursePaths, request: CoursePeriodRequest): string {
  const number = positiveOrdinal(request.number)
  if (request.kind === "milestone") {
    const title = request.title === undefined ? "" : humanPathSegment(request.title, "")
    const suffix = title.length === 0 ? "" : ` - ${title}`
    return join(course.root, `Milestone ${number}${suffix}`)
  }
  const date = calendarDate(request.date)
  const label = date === null ? humanPathSegment(request.title ?? "", "") : monthDay(date)
  const suffix = label.length === 0 ? "" : ` - ${label}`
  return join(course.root, `Week ${number}${suffix}`)
}

export function assignmentPaths(
  course: CoursePaths,
  request: AssignmentPathRequest,
): AssignmentPaths {
  const directory = assignmentDirectory(course, request)
  return {
    root: directory,
    directory,
    prompt: join(directory, vaultLayout.prompt),
    materials: join(directory, vaultLayout.materials),
    drafts: join(directory, vaultLayout.draftsDirectory),
    final: join(directory, vaultLayout.finalDirectory),
    feedback: join(directory, vaultLayout.feedbackFile),
  }
}

/** Assignment folder names use due date for chronology, never Canvas ID. */
export function assignmentDirectory(course: CoursePaths, request: AssignmentPathRequest): string {
  const title = humanPathSegment(request.title, "Untitled Assignment")
  const date = calendarDate(request.dueAt ?? request.date)
  const prefix = date === null ? "Undated" : date
  return join(course.assignments, `${prefix} - ${title}`)
}

/** The per-course assignment landing page. */
export function assignmentsIndexPath(course: CoursePaths): string {
  return course.assignmentsIndex
}

/**
 * Derive an artifact path in the v2 tree. Explicit period/assignment data is
 * preferred; adapters may pass `layout: "v1"` while being migrated. The
 * function deliberately does not add Canvas IDs to human-facing names.
 */
export function courseDocumentPath(course: CoursePaths, request: VaultPathRequest): string {
  if (request.layout === "v1") return legacyCourseDocumentPath(course.legacy, request)

  const filename = `${humanPathSegment(request.title, `Untitled ${request.kind}`)}${vaultLayout.markdownExtension}`
  switch (request.kind) {
    case vaultDocumentKinds.syllabus:
      return course.syllabus
    case vaultDocumentKinds.module: {
      if (
        request.period === undefined &&
        (request.module?.date === undefined || request.module.date === null)
      ) {
        return join(course.other, filename)
      }
      const period = periodPaths(course, periodRequest(request))
      const isOverview =
        request.module?.canvasId !== undefined &&
        String(request.module.canvasId) === String(request.canvasId)
      if (isOverview) return period.overview
      return join(periodBucket(period, request.bucket), filename)
    }
    case vaultDocumentKinds.assignment:
      return assignmentPaths(course, assignmentRequest(request)).prompt
    case vaultDocumentKinds.announcement:
      return join(course.announcements, filename)
    case vaultDocumentKinds.file:
      return request.period === undefined && request.module === undefined
        ? join(course.files, filename)
        : join(
            periodBucket(
              periodPaths(course, periodRequest(request)),
              request.bucket ?? "materials",
            ),
            filename,
          )
    case vaultDocumentKinds.prep:
      return request.period === undefined && request.module === undefined
        ? join(course.prep, filename)
        : join(periodPaths(course, periodRequest(request)).prep, filename)
    case vaultDocumentKinds.guidance:
      return join(course.guidance, filename)
    case vaultDocumentKinds.draft:
      return request.assignment === undefined
        ? join(course.drafts, filename)
        : join(assignmentPaths(course, assignmentRequest(request)).drafts, filename)
    case vaultDocumentKinds.final:
      return request.assignment === undefined
        ? join(course.final, filename)
        : join(assignmentPaths(course, assignmentRequest(request)).final, filename)
    case vaultDocumentKinds.feedback:
      return request.assignment === undefined
        ? join(
            course.assignments,
            `${humanPathSegment(request.title, "Untitled Assignment")} - Feedback${vaultLayout.markdownExtension}`,
          )
        : assignmentPaths(course, assignmentRequest(request)).feedback
    case vaultDocumentKinds.playbook:
      return course.playbook
  }
}

/** Explicit compatibility adapter for the pre-v2 flat tree. */
export function legacyCourseDocumentPath(
  course: LegacyCoursePaths | CoursePaths,
  request: VaultPathRequest,
): string {
  const paths = "legacy" in course ? course.legacy : course
  const filename = `${slugify(request.title, `untitled-${request.canvasId}`)}${vaultLayout.markdownExtension}`
  switch (request.kind) {
    case vaultDocumentKinds.syllabus:
      return paths.syllabus
    case vaultDocumentKinds.module:
      return join(legacyModuleDirectory(paths, request.module, request.canvasId), filename)
    case vaultDocumentKinds.assignment:
      return join(paths.assignments, filename)
    case vaultDocumentKinds.announcement:
      return join(paths.announcements, filename)
    case vaultDocumentKinds.file:
      return join(paths.files, filename)
    case vaultDocumentKinds.prep:
      return join(paths.prep, filename)
    case vaultDocumentKinds.guidance:
      return join(paths.guidance, filename)
    case vaultDocumentKinds.draft:
      return join(paths.drafts, filename)
    case vaultDocumentKinds.final:
      return join(paths.final, filename)
    case vaultDocumentKinds.feedback:
      return join(
        paths.assignments,
        `${slugify(request.title, `untitled-${request.canvasId}`)}.feedback.md`,
      )
    case vaultDocumentKinds.playbook:
      return paths.playbook
  }
}

/** Per-course session-sweep output: one run per teaching session. */
export type DogfoodSweepPaths = {
  readonly directory: string
  readonly sessionResultsPath: (sessionNumber: number, weekDate: string) => string
  readonly sessionSummaryPath: (sessionNumber: number, weekDate: string) => string
  readonly indexPath: (startDate: string) => string
  readonly indexSummaryPath: (startDate: string) => string
}

export function dogfoodSweepPaths(root: string, courseSlug: string): DogfoodSweepPaths {
  const directory = join(root, vaultLayout.metadata, vaultLayout.dogfood, courseSlug)
  const sessionBase = (sessionNumber: number, weekDate: string): string =>
    join(directory, `session-${String(sessionNumber).padStart(2, "0")}-${weekDate}-results`)
  return {
    directory,
    sessionResultsPath: (sessionNumber, weekDate) => `${sessionBase(sessionNumber, weekDate)}.json`,
    sessionSummaryPath: (sessionNumber, weekDate) => `${sessionBase(sessionNumber, weekDate)}.md`,
    indexPath: (startDate) => join(directory, `sweep-${startDate}.json`),
    indexSummaryPath: (startDate) => join(directory, `sweep-${startDate}.md`),
  }
}

export function canvasUpdatePath(path: string): string {
  const parsed = parse(path)
  return join(parsed.dir, `${parsed.name}${vaultLayout.canvasUpdate}${parsed.ext}`)
}

export function versionedPath(path: string, version: number): string {
  const parsed = parse(path)
  return join(parsed.dir, `${parsed.name}.v${version}${parsed.ext}`)
}

/** The `.xlsx` sibling of a written draft path. */
export function xlsxSiblingPath(path: string): string {
  const parsed = parse(path)
  return join(parsed.dir, `${parsed.name}.xlsx`)
}

export function iCloudStubPath(path: string): string {
  return `${path}${vaultLayout.iCloudStub}`
}

/** Lowercase slug used by legacy machine-oriented names and lookup indexes. */
export function slugify(value: string, fallback: string): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  const slug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
  return slug.length > 0 ? slug : fallback
}

/**
 * Make a human-facing path component safe and stable without lowercasing it.
 * Canvas IDs are intentionally not accepted as a fallback: they belong in
 * frontmatter, not in a navigational name.
 */
export function humanPathSegment(value: string, fallback: string): string {
  const normalized = replaceUnsafeHumanCharacters(value.normalize("NFKD"))
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[-. ]+$/g, "")
    .slice(0, 96)
  if (normalized.length === 0 || normalized === "." || normalized === "..") return fallback
  return normalized
}

/** Alias with a name useful to callers that think in terms of file names. */
export const safeHumanName = humanPathSegment

function replaceUnsafeHumanCharacters(value: string): string {
  let result = ""
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint < 0x20 || codePoint === 0x7f) {
      result += " "
    } else if ('\\/:?*[]<>|"'.includes(character)) {
      result += " - "
    } else {
      result += character
    }
  }
  return result
}

function legacyModuleDirectory(
  course: LegacyCoursePaths,
  module: VaultPathRequest["module"],
  itemCanvasId: string | number,
): string {
  const fallback = "untitled-module"
  const moduleName = module === undefined ? fallback : slugify(module.title, fallback)
  const moduleNumber = String(module?.number ?? 0).padStart(2, "0")
  // Important: the directory identity is the containing Canvas module, not
  // the item's Canvas ID. Module pages/files used to fan out into duplicate
  // directories because the caller's item ID was used here.
  const moduleIdentity = module?.canvasId ?? itemCanvasId
  return join(course.modules, `${moduleNumber}-${moduleName}-${moduleIdentity}`)
}

function periodRequest(request: VaultPathRequest): CoursePeriodRequest {
  if (request.period !== undefined) return request.period
  const module = request.module
  return {
    kind: module?.kind ?? "week",
    number: module?.number ?? 0,
    ...(module?.date === undefined ? {} : { date: module.date }),
    ...(module?.title === undefined ? {} : { title: module.title }),
  }
}

function assignmentRequest(request: VaultPathRequest): AssignmentPathRequest {
  return request.assignment ?? { title: request.title }
}

function periodBucket(period: CoursePeriodPaths, bucket: VaultPathRequest["bucket"]): string {
  switch (bucket) {
    case "prep":
      return period.prep
    case "other":
      return period.other
    case "materials":
    case undefined:
      return period.materials
  }
}

function positiveOrdinal(value: number): string {
  if (!Number.isFinite(value)) return "00"
  return String(Math.max(0, Math.trunc(value))).padStart(2, "0")
}

function calendarDate(value: CalendarValue | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null
    return value.toISOString().slice(0, 10)
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (iso !== null && validDateParts(iso[1], iso[2], iso[3])) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  const result = new Date(parsed)
  if (!Number.isFinite(result.getTime())) return null
  return result.toISOString().slice(0, 10)
}

function validDateParts(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined,
): boolean {
  if (year === undefined || month === undefined || day === undefined) return false
  const monthNumber = Number(month)
  const dayNumber = Number(day)
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return false
  const date = new Date(Date.UTC(Number(year), monthNumber - 1, dayNumber))
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === monthNumber - 1 &&
    date.getUTCDate() === dayNumber
  )
}

function monthDay(date: string): string {
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  const monthName = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][month - 1]
  return `${monthName ?? "???"} ${day}`
}
