import { readFile } from "node:fs/promises"
import { relative, sep } from "node:path"

import { z } from "zod"
import { coursePaths, vaultDocumentKinds } from "../store/paths.js"
import {
  parseVaultDocument,
  type VaultWriteResult,
  type VaultWriter,
  vaultSources,
  vaultStatuses,
} from "../store/vault.js"
import {
  type Assignment,
  type CanvasFile,
  type CanvasPage,
  type Course,
  type DiscussionTopic,
  getFile,
  getOwnSubmission,
  type Module,
  type Quiz,
} from "./endpoints.js"
import { type FileAuditGap, type FileIndexRecord, syncCanvasFile } from "./files.js"
import { permissionDeniedStatus } from "./http.js"
import {
  classifyNavigationItem,
  type NavigationDocument,
  type NavigationPeriod,
  navigationDate,
} from "./sync-navigation.js"
import {
  courseUrl,
  fileArtifactDates,
  fileIdsFromHtml,
  hasGradedFeedback,
  moduleDates,
  renderDiscussion,
  renderFeedback,
  renderQuiz,
} from "./sync-render.js"
import type { CanvasSyncInput, SyncChange, SyncPermissionGap } from "./sync-types.js"

// allow: SIZE_OK — this module owns every canvas-resource sync path (collection files, module-file
// recovery, assignment-linked-file recovery, discussion/quiz text resources, and graded feedback);
// splitting would separate tightly coupled manifest/gap/permission bookkeeping that the per-course
// transaction relies on.
const fileIndexRecordSchema = z.strictObject({
  canvasUrl: z.url(),
  metadataHash: z.string(),
  downloaded: z.boolean(),
  extracted: z.boolean(),
  degraded: z.boolean(),
})

export type VaultCourse = {
  readonly code: string
  readonly canvasId: string | number
  readonly canvasUrl: string
  readonly aiPolicy: "allowed" | "prohibited"
}

export type SyncResourceInput = {
  readonly options: CanvasSyncInput
  readonly writer: VaultWriter
  readonly now: () => Date
  readonly canvasCourse: Course
  readonly course: VaultCourse
  /** Resolved once per course sync (see `resolveCourseYear`); threaded through so every `moduleDates` call resolves `session_at` consistently. */
  readonly courseYear?: number
  /** Mutable per-course collector used to render Home/Overview after writes. */
  readonly navigation?: SyncNavigationCollector
  /** Precomputed human period placement keyed by containing Canvas module id. */
  readonly modulePeriods?: ReadonlyMap<string, NavigationPeriod>
  /** File ids already placed through a module/page/assignment relationship. */
  readonly skipFileIds?: ReadonlySet<string>
}

export type SyncNavigationCollector = {
  readonly courseRoot: string
  readonly documents: NavigationDocument[]
}

type ArtifactInput = {
  readonly writer: VaultWriter
  readonly course: VaultCourse
  readonly kind: (typeof vaultDocumentKinds)[keyof typeof vaultDocumentKinds]
  readonly title: string
  readonly canvasId: string | number
  readonly canvasUrl: string
  readonly content: string
  readonly dates?: Readonly<Record<string, string | null>>
  readonly module?: {
    readonly number: number
    readonly title: string
    readonly canvasId?: string | number
  }
  readonly moduleCanvasId?: string | number
  readonly period?: {
    readonly kind?: "week" | "milestone"
    readonly number: number
    readonly date?: string | Date | null
    readonly title?: string
  }
  readonly assignment?: {
    readonly title: string
    readonly dueAt?: string | Date | null
  }
  readonly bucket?: "prep" | "materials" | "other"
  readonly navigation?: SyncNavigationCollector
}

export async function syncFiles(
  input: SyncResourceInput & {
    readonly files: readonly CanvasFile[]
    readonly gaps: FileAuditGap[]
    readonly permissionGaps: SyncPermissionGap[]
  },
): Promise<void> {
  for (const file of input.files) {
    if (input.skipFileIds?.has(String(file.id))) continue
    await syncFileRecord(input, file)
  }
}

export async function syncModuleFiles(
  input: SyncResourceInput & {
    readonly modules: readonly Module[]
    readonly gaps: FileAuditGap[]
    readonly permissionGaps: SyncPermissionGap[]
  },
): Promise<void> {
  for (const { module, item } of moduleFileItems(input.modules)) {
    const contentId = item.content_id
    if (contentId === undefined) continue
    if (input.skipFileIds instanceof Set) input.skipFileIds.add(String(contentId))
    const dates = moduleDates(module, input.courseYear)
    await recoverFileById(input, contentId, {
      ...(item.title === undefined ? {} : { displayNameFallback: item.title }),
      ...(dates === undefined ? {} : { dates }),
      moduleCanvasId: module.id,
      period: modulePeriod(input, module.id),
      bucket: classifyNavigationItem({
        title: item.title ?? `File ${contentId}`,
        path: item.title ?? "",
        type: "file",
      }),
    })
  }
}

export async function syncAssignmentFiles(
  input: SyncResourceInput & {
    readonly assignments: readonly Assignment[]
    readonly gaps: FileAuditGap[]
    readonly permissionGaps: SyncPermissionGap[]
    /** assignment canvas_id -> owning module canvas_id, built from the already-fetched module item list. */
    readonly assignmentModuleIds?: ReadonlyMap<string, string>
  },
): Promise<void> {
  for (const assignment of input.assignments) {
    const dates: Readonly<Record<string, string | null>> = {
      due_at: assignment.due_at ?? null,
      created_at: assignment.created_at ?? null,
      unlock_at: assignment.unlock_at ?? null,
    }
    const moduleCanvasId = input.assignmentModuleIds?.get(String(assignment.id))
    for (const fileId of fileIdsFromHtml(assignment.description)) {
      if (input.skipFileIds instanceof Set) input.skipFileIds.add(String(fileId))
      await recoverFileById(input, fileId, {
        dates,
        ...(moduleCanvasId === undefined ? {} : { moduleCanvasId }),
        ...(moduleCanvasId === undefined ? {} : { period: modulePeriod(input, moduleCanvasId) }),
        assignment: {
          title: assignment.name ?? `Assignment ${assignment.id}`,
          dueAt: assignment.due_at ?? null,
        },
        bucket: "materials",
      })
    }
  }
}

/**
 * Recovers files linked by `/files/<id>` inside module Page bodies — the
 * case-PDF-from-a-session-page shape (a page's own `/pages/:url` payload
 * carries `body`, distinct from a module File item pointing directly at a
 * file). Uses the owning module's date signals as the visibility fallback,
 * mirroring `syncAssignmentFiles`.
 */
export async function syncPageFiles(
  input: SyncResourceInput & {
    readonly pages: ReadonlyArray<{ readonly page: CanvasPage; readonly module: Module }>
    readonly gaps: FileAuditGap[]
    readonly permissionGaps: SyncPermissionGap[]
  },
): Promise<void> {
  for (const { page, module } of input.pages) {
    const dates = moduleDates(module, input.courseYear)
    for (const fileId of fileIdsFromHtml(page.body)) {
      if (input.skipFileIds instanceof Set) input.skipFileIds.add(String(fileId))
      await recoverFileById(input, fileId, {
        ...(dates === undefined ? {} : { dates }),
        moduleCanvasId: module.id,
        period: modulePeriod(input, module.id),
        bucket: classifyNavigationItem({
          title: page.title ?? page.url,
          path: page.url,
          type: "page",
          ...(page.body === null || page.body === undefined ? {} : { content: page.body }),
        }),
      })
    }
  }
}

/**
 * Recovers files linked by `/files/<id>` inside the course syllabus body.
 * The syllabus has no per-item date signal of its own, so no fallback is
 * passed — a recovered file falls back to its own created_at/updated_at,
 * which `fileArtifactDates` already treats as leak-safe.
 */
export async function syncSyllabusFiles(
  input: SyncResourceInput & {
    readonly syllabusBody: string | null | undefined
    readonly gaps: FileAuditGap[]
    readonly permissionGaps: SyncPermissionGap[]
  },
): Promise<void> {
  for (const fileId of fileIdsFromHtml(input.syllabusBody)) {
    if (input.skipFileIds instanceof Set) input.skipFileIds.add(String(fileId))
    await recoverFileById(input, fileId)
  }
}

async function recoverFileById(
  input: SyncResourceInput & {
    readonly gaps: FileAuditGap[]
    readonly permissionGaps: SyncPermissionGap[]
  },
  fileId: string | number,
  opts?: {
    readonly displayNameFallback?: string
    readonly dates?: Readonly<Record<string, string | null>>
    readonly moduleCanvasId?: string | number
    readonly period?: ArtifactInput["period"]
    readonly assignment?: ArtifactInput["assignment"]
    readonly bucket?: ArtifactInput["bucket"]
  },
): Promise<void> {
  let file: CanvasFile
  try {
    file = await getFile(input.options.client, input.canvasCourse.id, fileId)
  } catch (error: unknown) {
    const status = permissionDeniedStatus(error)
    if (status !== null) {
      input.permissionGaps.push({
        resource: "files",
        status,
        courseId: String(input.canvasCourse.id),
        canvasUrl: courseUrl(input.options.canvasBaseUrl, input.canvasCourse.id),
      })
      return
    }
    throw error
  }
  await syncFileRecord(
    input,
    { ...file, display_name: file.display_name ?? opts?.displayNameFallback },
    opts?.dates,
    opts?.moduleCanvasId,
    opts,
  )
}

async function syncFileRecord(
  input: SyncResourceInput & {
    readonly gaps: FileAuditGap[]
    readonly permissionGaps: SyncPermissionGap[]
  },
  file: CanvasFile,
  dates?: Readonly<Record<string, string | null>>,
  moduleCanvasId?: string | number,
  placement?: {
    readonly period?: ArtifactInput["period"]
    readonly assignment?: ArtifactInput["assignment"]
    readonly bucket?: ArtifactInput["bucket"]
  },
): Promise<void> {
  // Canvas can return an empty-string `url` for some files (not just null/undefined),
  // and `??` would keep the empty string — an invalid canvas_url that later fails z.url()
  // both on the artifact write and when the cached index record is re-parsed. Treat empty
  // as absent and fall back to the course URL.
  const canvasUrl =
    file.url === undefined || file.url.length === 0
      ? courseUrl(input.options.canvasBaseUrl, input.canvasCourse.id)
      : file.url
  const fileId = String(file.id)
  const previous =
    input.options.full === true
      ? undefined
      : previousFileRecord(input.options.index.metadata(`file:${fileId}`))
  if (file.size === undefined || file.updated_at === undefined) {
    input.options.index.upsertFile({
      canvasId: file.id,
      courseCanvasId: input.canvasCourse.id,
      displayName: file.display_name ?? null,
      url: canvasUrl,
      vaultPath: null,
    })
    return
  }
  let result: Awaited<ReturnType<typeof syncCanvasFile>>
  try {
    result = await syncCanvasFile({
      client: input.options.client,
      file: {
        id: fileId,
        displayName: file.display_name ?? `File ${fileId}`,
        size: file.size,
        updatedAt: file.updated_at,
        canvasUrl,
        ...(file.url === undefined ? {} : { downloadUrl: file.url }),
        ...(file.content_type === undefined ? {} : { contentType: file.content_type }),
      },
      maxSizeMB: input.options.maxFileSizeMB,
      ...(previous === undefined ? {} : { previous }),
    })
  } catch (error: unknown) {
    const status = permissionDeniedStatus(error)
    if (status !== null) {
      input.permissionGaps.push({
        resource: "files",
        status,
        courseId: String(input.canvasCourse.id),
        canvasUrl,
      })
      return
    }
    throw error
  }
  input.options.index.setMetadata({ key: `file:${fileId}`, value: JSON.stringify(result.index) })
  switch (result.status) {
    case "processed": {
      const artifactDates = fileArtifactDates(file, dates)
      const artifact = await writeArtifact({
        writer: input.writer,
        course: input.course,
        kind: vaultDocumentKinds.file,
        title: file.display_name ?? `File ${fileId}`,
        canvasId: file.id,
        canvasUrl,
        content: result.extraction.text ?? "",
        ...(artifactDates === undefined ? {} : { dates: artifactDates }),
        ...(moduleCanvasId === undefined ? {} : { moduleCanvasId }),
        ...(placement?.period === undefined ? {} : { period: placement.period }),
        ...(placement?.assignment === undefined ? {} : { assignment: placement.assignment }),
        ...(placement?.bucket === undefined ? {} : { bucket: placement.bucket }),
        ...(input.navigation === undefined ? {} : { navigation: input.navigation }),
      })
      input.options.index.upsertFile({
        canvasId: file.id,
        courseCanvasId: input.canvasCourse.id,
        displayName: file.display_name ?? null,
        url: canvasUrl,
        vaultPath: artifact.path,
      })
      if (result.gap !== null) input.gaps.push(result.gap)
      return
    }
    case "oversize":
    case "no-download-url":
      input.gaps.push(result.gap)
      input.options.index.upsertFile({
        canvasId: file.id,
        courseCanvasId: input.canvasCourse.id,
        displayName: file.display_name ?? null,
        url: canvasUrl,
        vaultPath: null,
      })
      return
    case "skipped":
      return
    default:
      assertNever(result)
  }
}

function moduleFileItems(
  modules: readonly Module[],
): ReadonlyArray<{ readonly module: Module; readonly item: NonNullable<Module["items"]>[number] }> {
  const entries: { module: Module; item: NonNullable<Module["items"]>[number] }[] = []
  for (const module of modules) {
    for (const item of module.items ?? []) {
      if (item.type === "File" && item.content_id !== undefined) {
        entries.push({ module, item })
      }
    }
  }
  return entries
}

export async function syncTextResources(
  input: SyncResourceInput & {
    readonly discussions: readonly DiscussionTopic[]
    readonly quizzes: readonly Quiz[]
  },
): Promise<void> {
  for (const discussion of input.discussions) {
    await writeArtifact({
      writer: input.writer,
      course: input.course,
      kind: vaultDocumentKinds.module,
      title: `Discussion ${discussion.title ?? discussion.id}`,
      canvasId: discussion.id,
      canvasUrl:
        discussion.html_url ?? courseUrl(input.options.canvasBaseUrl, input.canvasCourse.id),
      content: renderDiscussion(discussion),
      module: { number: 0, title: "Synced discussions" },
      ...(input.navigation === undefined ? {} : { navigation: input.navigation }),
    })
  }
  for (const quiz of input.quizzes) {
    await writeArtifact({
      writer: input.writer,
      course: input.course,
      kind: vaultDocumentKinds.module,
      title: `Quiz ${quiz.title ?? quiz.id}`,
      canvasId: quiz.id,
      canvasUrl: quiz.html_url ?? courseUrl(input.options.canvasBaseUrl, input.canvasCourse.id),
      content: renderQuiz(quiz),
      module: { number: 0, title: "Synced quizzes" },
      ...(input.navigation === undefined ? {} : { navigation: input.navigation }),
    })
  }
}

export async function syncFeedback(
  input: SyncResourceInput & { readonly assignment: Assignment; readonly changes: SyncChange[] },
): Promise<void> {
  const submission = await getOwnSubmission(
    input.options.client,
    input.canvasCourse.id,
    input.assignment.id,
  )
  input.options.index.upsertSubmission({
    canvasId: submission.id,
    assignmentCanvasId: input.assignment.id,
    courseCanvasId: input.canvasCourse.id,
    workflowState: submission.workflow_state ?? null,
    submittedAt: submission.submitted_at ?? null,
  })
  if (!hasGradedFeedback(submission)) return
  const content = renderFeedback(submission)
  const feedback = await writeArtifact({
    writer: input.writer,
    course: input.course,
    kind: vaultDocumentKinds.feedback,
    title: input.assignment.name ?? `Assignment ${input.assignment.id}`,
    canvasId: `${input.assignment.id}-feedback`,
    canvasUrl:
      input.assignment.html_url ?? courseUrl(input.options.canvasBaseUrl, input.canvasCourse.id),
    content,
    assignment: {
      title: input.assignment.name ?? `Assignment ${input.assignment.id}`,
      dueAt: input.assignment.due_at ?? null,
    },
  })
  if (feedback.kind === "unchanged") return
  const path = coursePaths(
    input.options.vaultPath,
    input.course.code,
    input.course.canvasId,
  ).playbook
  const previous = await existingBody(path)
  const date = input.now().toISOString().slice(0, 10)
  await writeArtifact({
    writer: input.writer,
    course: input.course,
    kind: vaultDocumentKinds.playbook,
    title: "Course playbook",
    canvasId: "course-playbook",
    canvasUrl: courseUrl(input.options.canvasBaseUrl, input.canvasCourse.id),
    content: [
      previous,
      `## ${date} — ${input.assignment.name ?? `Assignment ${input.assignment.id}`}\n\n${content}`,
    ]
      .filter((value) => value.length > 0)
      .join("\n\n"),
  })
  input.changes.push({
    resource: "feedback",
    canvasId: String(input.assignment.id),
    detail: "graded feedback",
  })
}

export async function writeArtifact(input: ArtifactInput): Promise<VaultWriteResult> {
  const result = await input.writer.write({
    course: input.course,
    kind: input.kind,
    title: input.title,
    canvasId: input.canvasId,
    canvasUrl: input.canvasUrl,
    content: input.content,
    ...(input.dates === undefined ? {} : { dates: input.dates }),
    source: vaultSources.sync,
    status: vaultStatuses.final,
    ...(input.module === undefined ? {} : { module: input.module }),
    ...(input.moduleCanvasId === undefined ? {} : { moduleCanvasId: input.moduleCanvasId }),
    ...(input.period === undefined ? {} : { period: input.period }),
    ...(input.assignment === undefined ? {} : { assignment: input.assignment }),
    ...(input.bucket === undefined ? {} : { bucket: input.bucket }),
  })
  if (input.navigation !== undefined && shouldRecordNavigation(input.kind)) {
    const periodId = navigationPeriodId(input.period)
    input.navigation.documents.push({
      title: input.title,
      path: relative(input.navigation.courseRoot, result.path).split(sep).join("/"),
      type: input.kind,
      canvasId: input.canvasId,
      ...(input.dates === undefined ? {} : { dates: input.dates }),
      ...(input.content.length === 0 ? {} : { content: input.content }),
      ...(periodId === undefined ? {} : { periodId }),
      ...(input.period?.title === undefined ? {} : { periodTitle: input.period.title }),
    })
  }
  return result
}

function navigationPeriodId(period: ArtifactInput["period"]): string | undefined {
  if (period === undefined) return undefined
  if ((period.kind ?? "week") === "milestone") return `milestone-${period.number}`
  const date = navigationDate(period.date)
  return date === null ? undefined : `week-${date}`
}

function shouldRecordNavigation(kind: string): boolean {
  return kind !== vaultDocumentKinds.feedback && kind !== vaultDocumentKinds.playbook
}

function modulePeriod(
  input: SyncResourceInput,
  moduleId: string | number,
): ArtifactInput["period"] | undefined {
  const period = input.modulePeriods?.get(String(moduleId))
  if (period === undefined) return undefined
  return {
    kind: period.kind,
    number: period.number,
    date: navigationDate(period.startDate),
    title: period.title,
  }
}

function previousFileRecord(value: string | null): FileIndexRecord | undefined {
  // A malformed or schema-invalid cached record (e.g. one written before a bug fix)
  // must not wedge the whole course sync — treat it as "no previous" so the file is
  // re-downloaded and a fresh, valid record replaces it.
  if (value === null) return undefined
  try {
    const parsed = fileIndexRecordSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

async function existingBody(path: string): Promise<string> {
  try {
    return parseVaultDocument(await readFile(path, "utf8"), path).content.trim()
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""
    throw error
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected sync file result: ${JSON.stringify(value)}`)
}
