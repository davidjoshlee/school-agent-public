import { posix } from "node:path"

/** A date map taken directly from a synced vault document's frontmatter. */
export type NavigationDates = Readonly<Record<string, string | null | undefined>> & {
  readonly due_at?: string | null
}

export type NavigationCategory = "prep" | "materials" | "other"
export type NavigationPeriodKind = "week" | "milestone"

/**
 * The small normalized record needed by the navigation module.
 *
 * `path` is relative to the course directory and is deliberately supplied by
 * the caller.  The module does not know the v2 path vocabulary; the writer
 * (or an adapter next to it) decides where the synced artifact lives and then
 * passes that path here.
 */
export type NavigationDocument = {
  readonly title: string
  readonly path: string
  readonly type?: string
  readonly canvasId?: string | number
  readonly dates?: NavigationDates
  readonly moduleCanvasId?: string
  /** An explicit category is authoritative when supplied by a future adapter. */
  readonly category?: NavigationCategory
  /** An explicit period association is useful for milestone courses. */
  readonly periodId?: string
  readonly periodTitle?: string
  /** The body is optional and is only used for conservative title/body hints. */
  readonly content?: string
}

export type NavigationAssignment = {
  readonly title: string
  readonly path: string
  readonly canvasId?: string | number
  readonly dueAt?: string | null
  readonly periodId?: string
}

export type NavigationMilestone = {
  readonly id: string
  readonly title: string
  readonly startAt?: string | null
  readonly endAt?: string | null
  /** Optional explicit location for the generated overview. */
  readonly path?: string
}

export type NavigationCourse = {
  readonly name?: string | null
  readonly code?: string | null
  readonly path?: string
}

export type BuildNavigationInput = {
  readonly course: NavigationCourse
  readonly documents: readonly NavigationDocument[]
  readonly assignments?: readonly NavigationAssignment[]
  /** Defaults to `week`; pass `milestone` when the module is a named milestone. */
  readonly periodKind?: NavigationPeriodKind
  readonly milestones?: readonly NavigationMilestone[]
  /** Used only to identify the current period. Defaults to the current clock. */
  readonly now?: Date | string
  /** Relative path for the generated home page. Defaults to `00 Home.md`. */
  readonly homePath?: string
  /**
   * Explicitly overrides the weekly-publication signal. If omitted, dated
   * non-assignment content is considered published when at least one such
   * document exists.
   */
  readonly weeklyContentPublished?: boolean
}

export type NavigationAssignmentView = {
  readonly title: string
  readonly path: string
  readonly canvasId?: string
  readonly dueAt: string | null
  readonly periodId?: string
}

export type NavigationPeriod = {
  readonly id: string
  readonly kind: NavigationPeriodKind
  readonly number: number
  readonly title: string
  readonly directory: string
  readonly overviewPath: string
  readonly startDate: string | null
  readonly endDate: string | null
  readonly documents: Readonly<Record<NavigationCategory, readonly NavigationDocument[]>>
  readonly assignments: readonly NavigationAssignmentView[]
}

export type NavigationModel = {
  readonly course: NavigationCourse
  readonly homePath: string
  readonly periodKind: NavigationPeriodKind
  readonly periods: readonly NavigationPeriod[]
  readonly undatedDocuments: readonly NavigationDocument[]
  readonly undatedAssignments: readonly NavigationAssignmentView[]
  readonly currentPeriodId: string | null
  readonly nextPeriodId: string | null
  readonly weeklyContentPublished: boolean
  readonly weeklyContentMessage: string | null
}

export type NavigationArtifact = {
  readonly path: string
  readonly content: string
  readonly kind: "home" | "overview"
  readonly periodId?: string
}

const DATE_SIGNALS = [
  "session_at",
  "start_at",
  "unlock_at",
  "posted_at",
  "created_at",
  "due_at",
] as const

const PREP_PATH_RE = /(?:^|\/)(?:prep|preparation|pre-class)(?:\/|$)/i
const MATERIALS_PATH_RE = /(?:^|\/)(?:materials?|slides?|handouts?)(?:\/|$)/i

const PREP_TITLE_RE =
  /\b(?:prep(?:aration)?|pre[- ]?class|read(?:ing)?|case(?:\s+questions?)?|problem\s*set|questions?)\b/i
const MATERIALS_TITLE_RE =
  /\b(?:material(?:s)?|slide(?:s)?|deck|handout(?:s)?|lecture|recording|video|solution(?:s)?|answer(?:s)?|transcript|worksheet)\b/i

const ASSIGNMENT_TYPES = new Set(["assignment", "assignments"])

/**
 * Classifies a document using only high-confidence signals.
 *
 * Unknown Canvas types, generic module names, and ambiguous files intentionally
 * land in `other`.  A later adapter can supply `category` when Canvas metadata
 * or a user-maintained rule makes the classification certain.
 */
export function classifyNavigationItem(document: NavigationDocument): NavigationCategory {
  if (document.category !== undefined) return document.category

  const type = document.type?.toLowerCase()
  const path = normalizePath(document.path)
  const title = document.title.trim()
  const content = document.content?.slice(0, 1_000) ?? ""

  // Canvas assignments are rendered in their own section.  Return Other here
  // before title/path hints so a title such as "Problem Set" cannot leak into
  // Prep when callers classify the complete document list in one pass.
  if (type !== undefined && ASSIGNMENT_TYPES.has(type)) return "other"

  if (PREP_PATH_RE.test(path) || PREP_TITLE_RE.test(title)) return "prep"
  if (MATERIALS_PATH_RE.test(path) || MATERIALS_TITLE_RE.test(title)) return "materials"

  // Body text is a deliberately weak fallback: require an explicit heading
  // rather than classifying a generic page because it happens to mention
  // "reading" or "materials" in prose.
  if (/^\s{0,3}#{1,3}\s*(?:prep|pre[- ]?class)/im.test(content)) return "prep"
  if (/^\s{0,3}#{1,3}\s*(?:materials?|slides?|handouts?)/im.test(content)) return "materials"

  return "other"
}

/**
 * Converts parsed frontmatter into the normalized input consumed by this
 * module.  It is intentionally structural so it works with the current
 * frontmatter type as well as the v2 writer's compatible shape.
 */
export function navigationDocumentFromFrontmatter(input: {
  readonly path: string
  readonly title: string
  readonly frontmatter: {
    readonly canvas_id: string
    readonly type: string
    readonly dates: NavigationDates
    readonly module_canvas_id?: string
  }
  readonly content?: string
}): NavigationDocument {
  return {
    title: input.title,
    path: input.path,
    type: input.frontmatter.type,
    canvasId: input.frontmatter.canvas_id,
    dates: input.frontmatter.dates,
    ...(input.frontmatter.module_canvas_id === undefined
      ? {}
      : { moduleCanvasId: input.frontmatter.module_canvas_id }),
    ...(input.content === undefined ? {} : { content: input.content }),
  }
}

/** Creates an assignment summary from an assignment frontmatter record. */
export function navigationAssignmentFromFrontmatter(input: {
  readonly path: string
  readonly title: string
  readonly frontmatter: {
    readonly canvas_id: string
    readonly dates: NavigationDates
  }
}): NavigationAssignment {
  return {
    title: input.title,
    path: input.path,
    canvasId: input.frontmatter.canvas_id,
    dueAt: input.frontmatter.dates.due_at ?? null,
  }
}

/**
 * Builds all navigation state without reading or writing the filesystem.
 * Dates are interpreted as UTC calendar dates, which avoids a user's local
 * timezone moving a Canvas session across a week boundary.
 */
export function buildNavigationModel(input: BuildNavigationInput): NavigationModel {
  const periodKind = input.periodKind ?? (input.milestones !== undefined ? "milestone" : "week")
  const homePath = normalizePath(input.homePath ?? "00 Home.md")
  const nowDate = dateOnly(input.now ?? new Date()) ?? "9999-12-31"

  const assignmentViews = normalizeAssignments(input.assignments ?? [], input.documents)
  const entries = input.documents.filter((document) => !isAssignmentDocument(document))
  const datedEntries = entries
    .map((document) => ({ document, date: documentDate(document.dates) }))
    .filter((entry): entry is { document: NavigationDocument; date: string } => entry.date !== null)

  const periodDrafts = new Map<string, PeriodDraft>()
  const undatedDocuments: NavigationDocument[] = []
  const undatedAssignments: NavigationAssignmentView[] = []

  for (const entry of datedEntries) {
    if (periodKind === "week" && !isPeriodAnchoredDocument(entry.document)) {
      undatedDocuments.push(entry.document)
      continue
    }
    const period = resolvePeriodForDocument(
      entry.document,
      entry.date,
      periodKind,
      input.milestones,
    )
    if (period === null) {
      undatedDocuments.push(entry.document)
      continue
    }
    addDraft(
      periodDrafts,
      period,
      entry.document,
      entry.document.periodId === undefined ? entry.date : null,
    )
  }
  for (const document of entries) {
    if (documentDate(document.dates) === null && !undatedDocuments.includes(document)) {
      const period = resolveUndatedPeriodForDocument(document, periodKind, input.milestones)
      if (period === null) undatedDocuments.push(document)
      else addDraft(periodDrafts, period, document, null)
    }
  }

  for (const assignment of assignmentViews) {
    const date = dateOnly(assignment.dueAt)
    if (date === null) {
      undatedAssignments.push(assignment)
      if (assignment.periodId !== undefined) {
        const period = resolvePeriodById(assignment.periodId, periodKind, input.milestones)
        if (period !== null) addAssignmentDraft(periodDrafts, period, assignment, null)
      }
      continue
    }
    const period = resolvePeriodForAssignment(assignment, date, periodKind, input.milestones)
    if (period === null) {
      undatedAssignments.push(assignment)
      continue
    }
    addAssignmentDraft(
      periodDrafts,
      period,
      assignment,
      assignment.periodId === undefined ? date : null,
    )
  }

  const periods = materializePeriods(periodDrafts, periodKind)
  const currentPeriodId = findCurrentPeriod(periods, nowDate)
  const nextPeriodId = findNextPeriod(periods, nowDate, currentPeriodId)
  const weeklyContentPublished =
    input.weeklyContentPublished ??
    (datedEntries.length > 0 || periods.some((period) => hasContent(period)))

  return {
    course: input.course,
    homePath,
    periodKind,
    periods,
    undatedDocuments,
    undatedAssignments,
    currentPeriodId,
    nextPeriodId,
    weeklyContentPublished,
    weeklyContentMessage:
      periodKind === "week" && !weeklyContentPublished
        ? "Weekly content has not been published in Canvas yet. This page will populate when dated sessions or modules become available."
        : null,
  }
}

/** A small alias for callers that prefer the shorter verb. */
export const buildNavigation = buildNavigationModel

/** Returns a UTC calendar date suitable for period/path placement. */
export function navigationDate(value: string | Date | null | undefined): string | null {
  return dateOnly(value)
}

/** Finds the populated period containing a calendar date. */
export function navigationPeriodForDate(
  model: NavigationModel,
  value: string | Date | null | undefined,
): NavigationPeriod | null {
  const date = dateOnly(value)
  if (date === null) return null
  return (
    model.periods.find(
      (period) =>
        period.startDate !== null &&
        period.endDate !== null &&
        period.startDate <= date &&
        date <= period.endDate,
    ) ?? null
  )
}

/** Renders the course-level navigation page. */
export function renderHome(model: NavigationModel): string {
  const courseTitle = model.course.name ?? model.course.code ?? "Course"
  const lines = [`# ${courseTitle}`, ""]
  if (model.course.code !== undefined && model.course.code !== null) {
    lines.push(`**Course:** ${model.course.code}`, "")
  }

  lines.push("## Current / Next", "")
  const current = periodById(model, model.currentPeriodId)
  const next = periodById(model, model.nextPeriodId)
  lines.push(
    current === null ? "- **Current:** —" : `- **Current:** ${periodLink(current, model.homePath)}`,
    next === null ? "- **Next:** —" : `- **Next:** ${periodLink(next, model.homePath)}`,
    "",
  )

  if (model.weeklyContentMessage !== null) lines.push(`> ${model.weeklyContentMessage}`, "")

  lines.push("## Course periods", "")
  if (model.periods.length === 0) lines.push("- No dated periods are available yet.")
  else {
    for (const period of model.periods) {
      const marker = period.id === model.currentPeriodId ? " *(current)*" : ""
      lines.push(`- ${periodLink(period, model.homePath)}${marker}`)
    }
  }
  lines.push("")

  renderHomeCategory(lines, "Prep", model, "prep")
  renderHomeCategory(lines, "Materials", model, "materials")
  renderHomeCategory(lines, "Other", model, "other")
  renderHomeAssignments(lines, model)
  return `${lines.join("\n").trimEnd()}\n`
}

/** Renders one period's overview page. */
export function renderPeriodOverview(model: NavigationModel, periodId: string): string {
  const period = periodById(model, periodId)
  if (period === null) throw new Error(`Unknown navigation period: ${periodId}`)
  const lines = [`# ${period.title}`, ""]
  const status = period.id === model.currentPeriodId ? "Current period" : ""
  if (status.length > 0) lines.push(`_${status}_`, "")

  const index = model.periods.findIndex((candidate) => candidate.id === period.id)
  const previous = index > 0 ? model.periods[index - 1] : undefined
  const next = index >= 0 ? model.periods[index + 1] : undefined
  lines.push("## Navigation", "")
  lines.push(
    previous === undefined
      ? "- **Previous:** —"
      : `- **Previous:** ${periodLink(previous, period.overviewPath)}`,
    next === undefined ? "- **Next:** —" : `- **Next:** ${periodLink(next, period.overviewPath)}`,
    "",
  )

  renderDocumentSection(lines, "Prep", period.documents.prep, period.overviewPath)
  renderDocumentSection(lines, "Materials", period.documents.materials, period.overviewPath)
  renderDocumentSection(lines, "Other", period.documents.other, period.overviewPath)
  renderPeriodAssignments(lines, period)
  return `${lines.join("\n").trimEnd()}\n`
}

/** Returns the home and overview files a writer should persist. */
export function navigationArtifacts(model: NavigationModel): readonly NavigationArtifact[] {
  return [
    {
      path: model.homePath,
      content: renderHome(model),
      kind: "home",
    },
    ...model.periods.map((period) => ({
      path: period.overviewPath,
      content: renderPeriodOverview(model, period.id),
      kind: "overview" as const,
      periodId: period.id,
    })),
  ]
}

type PeriodRef = {
  readonly id: string
  readonly title: string
  readonly startDate: string | null
  readonly endDate: string | null
  readonly directory?: string
  readonly path?: string
}

type PeriodDraft = Omit<PeriodRef, "startDate" | "endDate"> & {
  startDate: string | null
  endDate: string | null
  readonly documents: {
    readonly prep: NavigationDocument[]
    readonly materials: NavigationDocument[]
    readonly other: NavigationDocument[]
  }
  readonly assignments: NavigationAssignmentView[]
}

function resolvePeriodForDocument(
  document: NavigationDocument,
  date: string,
  periodKind: NavigationPeriodKind,
  milestones: readonly NavigationMilestone[] | undefined,
): PeriodRef | null {
  if (document.periodId !== undefined) {
    const explicit = resolvePeriodById(document.periodId, periodKind, milestones)
    if (explicit !== null) return explicit
    if (periodKind === "milestone") {
      return {
        id: `milestone-${slugPart(document.periodId)}`,
        title: document.periodTitle ?? document.periodId,
        startDate: date,
        endDate: date,
      }
    }
  }
  if (periodKind === "milestone") {
    const milestone = milestones?.find((candidate) => withinMilestone(date, candidate))
    if (milestone !== undefined) return milestoneRef(milestone)
    // An explicit period association is preferred; if none exists, keep a
    // dated item visible under a clearly named fallback rather than pretending
    // that a non-week course follows a weekly cadence.
    return {
      id: `milestone-${date}`,
      title: `Milestone around ${formatDate(date)}`,
      startDate: date,
      endDate: date,
    }
  }
  const week = weekRef(date)
  return week
}

function resolveUndatedPeriodForDocument(
  document: NavigationDocument,
  periodKind: NavigationPeriodKind,
  milestones: readonly NavigationMilestone[] | undefined,
): PeriodRef | null {
  if (document.periodId === undefined) return null
  const explicit = resolvePeriodById(document.periodId, periodKind, milestones)
  if (explicit !== null) return explicit
  if (periodKind !== "milestone") return null
  return {
    id: `milestone-${slugPart(document.periodId)}`,
    title: document.periodTitle ?? document.periodId,
    startDate: null,
    endDate: null,
  }
}

function resolvePeriodForAssignment(
  assignment: NavigationAssignmentView,
  date: string,
  periodKind: NavigationPeriodKind,
  milestones: readonly NavigationMilestone[] | undefined,
): PeriodRef | null {
  if (assignment.periodId !== undefined) {
    const explicit = resolvePeriodById(assignment.periodId, periodKind, milestones)
    if (explicit !== null) return explicit
  }
  if (periodKind === "milestone") {
    const milestone = milestones?.find((candidate) => withinMilestone(date, candidate))
    return milestone === undefined
      ? {
          id: `milestone-${date}`,
          title: `Milestone around ${formatDate(date)}`,
          startDate: date,
          endDate: date,
        }
      : milestoneRef(milestone)
  }
  return weekRef(date)
}

function resolvePeriodById(
  id: string,
  periodKind: NavigationPeriodKind,
  milestones: readonly NavigationMilestone[] | undefined,
): PeriodRef | null {
  if (periodKind === "week") {
    const match = /^week-(\d{4}-\d{2}-\d{2})$/.exec(id)
    return match?.[1] === undefined ? null : weekRef(match[1])
  }
  const milestone = milestones?.find((candidate) => candidate.id === id)
  return milestone === undefined ? null : milestoneRef(milestone)
}

function milestoneRef(milestone: NavigationMilestone): PeriodRef {
  const startDate = dateOnly(milestone.startAt)
  const endDate = dateOnly(milestone.endAt) ?? startDate
  return {
    id: `milestone-${slugPart(milestone.id)}`,
    title: milestone.title,
    startDate,
    endDate,
    ...(milestone.path === undefined ? {} : { path: normalizePath(milestone.path) }),
  }
}

function weekRef(date: string): PeriodRef {
  const startDate = mondayOf(date)
  return {
    id: `week-${startDate}`,
    title: `Week of ${formatDate(startDate)}`,
    startDate,
    endDate: addDays(startDate, 6),
  }
}

function addDraft(
  drafts: Map<string, PeriodDraft>,
  ref: PeriodRef,
  document: NavigationDocument,
  date: string | null,
): void {
  const draft = getOrCreateDraft(drafts, ref)
  if (date !== null) {
    draft.startDate = minDate(draft.startDate, date)
    draft.endDate = maxDate(draft.endDate, date)
  }
  const category = classifyNavigationItem(document)
  draft.documents[category].push(document)
}

function addAssignmentDraft(
  drafts: Map<string, PeriodDraft>,
  ref: PeriodRef,
  assignment: NavigationAssignmentView,
  date: string | null,
): void {
  const draft = getOrCreateDraft(drafts, ref)
  if (date !== null) {
    draft.startDate = minDate(draft.startDate, date)
    draft.endDate = maxDate(draft.endDate, date)
  }
  if (!draft.assignments.some((candidate) => sameNavigationIdentity(candidate, assignment))) {
    draft.assignments.push(assignment)
  }
}

function getOrCreateDraft(drafts: Map<string, PeriodDraft>, ref: PeriodRef): PeriodDraft {
  const existing = drafts.get(ref.id)
  if (existing !== undefined) return existing
  const draft: PeriodDraft = {
    ...ref,
    documents: { prep: [], materials: [], other: [] },
    assignments: [],
  }
  drafts.set(ref.id, draft)
  return draft
}

function materializePeriods(
  drafts: Map<string, PeriodDraft>,
  periodKind: NavigationPeriodKind,
): readonly NavigationPeriod[] {
  const ordered = [...drafts.values()].sort(comparePeriods)
  return ordered.map((draft, index) => {
    const number = index + 1
    const directory =
      draft.directory ??
      (periodKind === "week"
        ? `Week ${String(number).padStart(2, "0")} - ${formatDate(draft.startDate ?? "")}`
        : `Milestone ${String(number).padStart(2, "0")} - ${draft.title}`)
    const overviewPath = draft.path ?? `${directory}/00 Overview.md`
    return {
      id: draft.id,
      kind: periodKind,
      number,
      title:
        periodKind === "week"
          ? `Week ${String(number).padStart(2, "0")} - ${formatDate(draft.startDate ?? "")}`
          : `Milestone ${String(number).padStart(2, "0")} - ${draft.title}`,
      directory,
      overviewPath: normalizePath(overviewPath),
      startDate: draft.startDate,
      endDate: draft.endDate,
      documents: {
        prep: [...draft.documents.prep].sort(compareDocuments),
        materials: [...draft.documents.materials].sort(compareDocuments),
        other: [...draft.documents.other].sort(compareDocuments),
      },
      assignments: [...draft.assignments].sort(compareAssignments),
    }
  })
}

function normalizeAssignments(
  assignments: readonly NavigationAssignment[],
  documents: readonly NavigationDocument[],
): readonly NavigationAssignmentView[] {
  const entries = new Map<string, NavigationAssignmentView>()
  for (const assignment of assignments) {
    const key = navigationIdentity(assignment.canvasId, assignment.path)
    entries.set(key, {
      title: assignment.title,
      path: normalizePath(assignment.path),
      ...(assignment.canvasId === undefined ? {} : { canvasId: String(assignment.canvasId) }),
      dueAt: assignment.dueAt ?? null,
      ...(assignment.periodId === undefined ? {} : { periodId: assignment.periodId }),
    })
  }
  for (const document of documents) {
    if (!isAssignmentDocument(document)) continue
    const key = navigationIdentity(document.canvasId, document.path)
    if (entries.has(key)) continue
    entries.set(key, {
      title: document.title,
      path: normalizePath(document.path),
      ...(document.canvasId === undefined ? {} : { canvasId: String(document.canvasId) }),
      dueAt: document.dates?.due_at ?? null,
      ...(document.periodId === undefined ? {} : { periodId: document.periodId }),
    })
  }
  return [...entries.values()]
}

function isAssignmentDocument(document: NavigationDocument): boolean {
  const type = document.type?.toLowerCase()
  return type !== undefined && ASSIGNMENT_TYPES.has(type)
}

function isPeriodAnchoredDocument(document: NavigationDocument): boolean {
  if (document.periodId !== undefined) return true
  const type = document.type?.toLowerCase()
  if (type === "module" || type === "modules") return true
  return /(?:^|\/)(?:week|milestone)\s+\d{2}(?:\s|\/|$)/i.test(normalizePath(document.path))
}

function periodById(model: NavigationModel, id: string | null): NavigationPeriod | null {
  if (id === null) return null
  return model.periods.find((period) => period.id === id) ?? null
}

function findCurrentPeriod(periods: readonly NavigationPeriod[], now: string): string | null {
  return (
    periods.find(
      (period) =>
        period.startDate !== null &&
        period.endDate !== null &&
        period.startDate <= now &&
        now <= period.endDate,
    )?.id ?? null
  )
}

function findNextPeriod(
  periods: readonly NavigationPeriod[],
  now: string,
  currentPeriodId: string | null,
): string | null {
  return (
    periods.find(
      (period) =>
        period.id !== currentPeriodId && period.startDate !== null && period.startDate > now,
    )?.id ?? null
  )
}

function hasContent(period: NavigationPeriod): boolean {
  return (
    period.documents.prep.length > 0 ||
    period.documents.materials.length > 0 ||
    period.documents.other.length > 0
  )
}

function renderHomeAssignments(lines: string[], model: NavigationModel): void {
  const assignments = model.periods.flatMap((period) => period.assignments)
  const all = dedupeAssignments([...assignments, ...model.undatedAssignments])
  lines.push("## Assignments due", "")
  if (all.length === 0) {
    lines.push("- No assignments are available yet.", "")
    return
  }
  for (const assignment of all) {
    const due =
      assignment.dueAt === null ? "date not set" : formatDate(dateOnly(assignment.dueAt) ?? "")
    lines.push(
      `- [${escapeLabel(assignment.title)}](${linkTarget(model.homePath, assignment.path)}) — ${due}`,
    )
  }
  lines.push("")
}

function renderHomeCategory(
  lines: string[],
  heading: string,
  model: NavigationModel,
  category: NavigationCategory,
): void {
  lines.push(`## ${heading}`, "")
  const entries: readonly HomeCategoryEntry[] = [
    ...model.periods.flatMap((period) =>
      period.documents[category].map((document) => ({ document, period })),
    ),
    ...(category === "other"
      ? model.undatedDocuments.map((document) => ({ document, period: null }))
      : []),
  ]
  if (entries.length === 0) {
    lines.push("- None", "")
    return
  }
  for (const entry of entries) {
    const context = entry.period === null ? "" : ` — ${entry.period.title}`
    lines.push(
      `- [${escapeLabel(entry.document.title)}](${linkTarget(model.homePath, entry.document.path)})${context}`,
    )
  }
  lines.push("")
}

type HomeCategoryEntry = {
  readonly document: NavigationDocument
  readonly period: NavigationPeriod | null
}

function renderDocumentSection(
  lines: string[],
  heading: string,
  documents: readonly NavigationDocument[],
  fromPath: string,
): void {
  lines.push(`## ${heading}`, "")
  if (documents.length === 0) {
    lines.push("- None", "")
    return
  }
  for (const document of documents) {
    lines.push(`- [${escapeLabel(document.title)}](${linkTarget(fromPath, document.path)})`)
  }
  lines.push("")
}

function renderPeriodAssignments(lines: string[], period: NavigationPeriod): void {
  lines.push("## Assignments due", "")
  if (period.assignments.length === 0) {
    lines.push("- None", "")
    return
  }
  for (const assignment of period.assignments) {
    const due =
      assignment.dueAt === null ? "date not set" : formatDate(dateOnly(assignment.dueAt) ?? "")
    lines.push(
      `- [${escapeLabel(assignment.title)}](${linkTarget(period.overviewPath, assignment.path)}) — ${due}`,
    )
  }
  lines.push("")
}

function periodLink(period: NavigationPeriod, fromPath: string): string {
  return `[${escapeLabel(period.title)}](${linkTarget(fromPath, period.overviewPath)})`
}

function linkTarget(fromPath: string, targetPath: string): string {
  const target = normalizePath(targetPath)
  const fromDirectory = posix.dirname(normalizePath(fromPath))
  const relative = posix.relative(fromDirectory, target)
  return relative.length === 0 ? posix.basename(target) : relative
}

function comparePeriods(a: PeriodRef, b: PeriodRef): number {
  const aDate = a.startDate ?? "9999-12-31"
  const bDate = b.startDate ?? "9999-12-31"
  return aDate.localeCompare(bDate) || a.title.localeCompare(b.title)
}

function compareDocuments(a: NavigationDocument, b: NavigationDocument): number {
  return (
    a.title.localeCompare(b.title) || normalizePath(a.path).localeCompare(normalizePath(b.path))
  )
}

function compareAssignments(a: NavigationAssignmentView, b: NavigationAssignmentView): number {
  const aDate = dateOnly(a.dueAt) ?? "9999-12-31"
  const bDate = dateOnly(b.dueAt) ?? "9999-12-31"
  return aDate.localeCompare(bDate) || a.title.localeCompare(b.title)
}

function dedupeAssignments(
  assignments: readonly NavigationAssignmentView[],
): NavigationAssignmentView[] {
  const seen = new Set<string>()
  const result: NavigationAssignmentView[] = []
  for (const assignment of assignments) {
    const key = navigationIdentity(assignment.canvasId, assignment.path)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(assignment)
  }
  return result.sort(compareAssignments)
}

function sameNavigationIdentity(
  left: NavigationAssignmentView,
  right: NavigationAssignmentView,
): boolean {
  return (
    navigationIdentity(left.canvasId, left.path) === navigationIdentity(right.canvasId, right.path)
  )
}

function navigationIdentity(canvasId: string | number | undefined, path: string): string {
  return canvasId === undefined ? `path:${normalizePath(path)}` : `canvas:${String(canvasId)}`
}

function withinMilestone(date: string, milestone: NavigationMilestone): boolean {
  const start = dateOnly(milestone.startAt)
  const end = dateOnly(milestone.endAt)
  return (start === null || date >= start) && (end === null || date <= end)
}

function documentDate(dates: NavigationDates | undefined): string | null {
  if (dates === undefined) return null
  for (const signal of DATE_SIGNALS) {
    const value = dates[signal]
    const parsed = dateOnly(value)
    if (parsed !== null) return parsed
  }
  return null
}

function dateOnly(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10)
  }
  const trimmed = value.trim()
  const direct = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed)
  if (direct !== null) return isValidIsoDate(direct[0]) ? direct[0] : null
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

function isValidIsoDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function mondayOf(date: string): string {
  const value = new Date(`${date}T00:00:00Z`)
  const day = value.getUTCDay()
  const daysSinceMonday = (day + 6) % 7
  value.setUTCDate(value.getUTCDate() - daysSinceMonday)
  return value.toISOString().slice(0, 10)
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function minDate(left: string | null, right: string): string {
  return left === null || right < left ? right : left
}

function maxDate(left: string | null, right: string): string {
  return left === null || right > left ? right : left
}

function formatDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "date not set"
  const value = new Date(`${date}T00:00:00Z`)
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(value)
}

function slugPart(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length === 0 ? "unspecified" : slug
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "")
}

function escapeLabel(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]")
}
