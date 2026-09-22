import { join, parse } from "node:path"

/** The complete versioned vault vocabulary; no other module owns layout names. */
export const vaultLayout = {
  version: 1,
  metadata: "_meta",
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
  syncLog: "sync-log.md",
  auth: "auth.json",
  alert: "ALERT.md",
  contextLog: "model-context-log.jsonl",
  coursePlaybook: "course-playbook.md",
  dogfood: "dogfood",
  layoutMetadata: "layout.json",
  markdownExtension: ".md",
  canvasUpdate: ".canvas-update",
  iCloudStub: ".icloud",
} as const

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

export const layoutSegments = [
  vaultLayout.metadata,
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
  vaultLayout.syncLog,
  vaultLayout.auth,
  vaultLayout.alert,
  vaultLayout.contextLog,
  vaultLayout.coursePlaybook,
  vaultLayout.dogfood,
  vaultLayout.layoutMetadata,
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

export type CoursePaths = {
  readonly root: string
  readonly syllabus: string
  readonly index: string
  readonly modules: string
  readonly assignments: string
  readonly announcements: string
  readonly files: string
  readonly prep: string
  readonly guidance: string
  /** `guidance/prep-guidance.proposed.md` — the agent-drafted proposal; the
   * user-owned `guidance/prep-guidance.md` is a sibling this path never equals. */
  readonly guidanceProposal: string
  readonly drafts: string
  readonly final: string
  readonly playbook: string
}

export type VaultPathRequest = {
  readonly kind: VaultDocumentKind
  readonly title: string
  readonly canvasId: string | number
  readonly module?: {
    readonly number: number
    readonly title: string
    readonly canvasId?: string | number
  }
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

export function coursePaths(
  root: string,
  courseCode: string,
  courseId: string | number,
): CoursePaths {
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

export function courseDocumentPath(course: CoursePaths, request: VaultPathRequest): string {
  const filename = `${slugify(request.title, `untitled-${request.canvasId}`)}${vaultLayout.markdownExtension}`
  switch (request.kind) {
    case vaultDocumentKinds.syllabus:
      return course.syllabus
    case vaultDocumentKinds.module:
      return join(moduleDirectory(course, request.module, request.canvasId), filename)
    case vaultDocumentKinds.assignment:
      return join(course.assignments, filename)
    case vaultDocumentKinds.announcement:
      return join(course.announcements, filename)
    case vaultDocumentKinds.file:
      return join(course.files, filename)
    case vaultDocumentKinds.prep:
      return join(course.prep, filename)
    case vaultDocumentKinds.guidance:
      return join(course.guidance, filename)
    case vaultDocumentKinds.draft:
      return join(course.drafts, filename)
    case vaultDocumentKinds.final:
      return join(course.final, filename)
    case vaultDocumentKinds.feedback:
      return join(
        course.assignments,
        `${slugify(request.title, `untitled-${request.canvasId}`)}.feedback.md`,
      )
    case vaultDocumentKinds.playbook:
      return course.playbook
  }
}

/** Per-course session-sweep output: one dogfood run per teaching session,
 * each with its own non-clobbering results/summary file, plus one aggregate
 * sweep index (see dogfood-sweep.ts). */
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

/** The `.xlsx` sibling of a written draft path — `pricing-memo.v2.md` →
 * `pricing-memo.v2.xlsx` — so a computational draft's spreadsheet always
 * sits next to the exact draft version it was extracted from. */
export function xlsxSiblingPath(path: string): string {
  const parsed = parse(path)
  return join(parsed.dir, `${parsed.name}.xlsx`)
}

export function iCloudStubPath(path: string): string {
  return `${path}${vaultLayout.iCloudStub}`
}

export function slugify(value: string, fallback: string): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  const slug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
  return slug.length > 0 ? slug : fallback
}

function moduleDirectory(
  course: CoursePaths,
  module: VaultPathRequest["module"],
  canvasId: string | number,
): string {
  const fallback = "untitled-module"
  const moduleName = module === undefined ? fallback : slugify(module.title, fallback)
  const moduleNumber = String(module?.number ?? 0).padStart(2, "0")
  return join(course.modules, `${moduleNumber}-${moduleName}-${canvasId}`)
}
