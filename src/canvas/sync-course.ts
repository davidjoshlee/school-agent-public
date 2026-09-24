import { randomUUID } from "node:crypto"
import { coursePaths, vaultDocumentKinds } from "../store/paths.js"
import type { VaultWriter } from "../store/vault.js"
import {
  type Announcement,
  type Assignment,
  type CanvasPage,
  type Course,
  getModulePage,
  getSyllabus,
  listAnnouncements,
  listAssignments,
  listCalendarEvents,
  listDiscussionTopics,
  listFiles,
  listModules,
  listQuizzes,
  type Module,
} from "./endpoints.js"
import type { FileAuditGap } from "./files.js"
import { permissionDeniedStatus } from "./http.js"
import {
  buildNavigationModel,
  classifyNavigationItem,
  type NavigationDocument,
  type NavigationPeriod,
  navigationArtifacts,
  navigationDate,
  navigationPeriodForDate,
} from "./sync-navigation.js"
import {
  courseUrl,
  moduleDates,
  renderAnnouncement,
  renderAssignment,
  renderModule,
  renderPage,
  renderSyllabus,
  resolveCourseYear,
} from "./sync-render.js"
import {
  type SyncNavigationCollector,
  type SyncResourceInput,
  syncAssignmentFiles,
  syncFeedback,
  syncFiles,
  syncModuleFiles,
  syncPageFiles,
  syncSyllabusFiles,
  syncTextResources,
  type VaultCourse,
  writeArtifact,
} from "./sync-resources.js"
import type {
  CanvasSyncInput,
  SyncChange,
  SyncCourseReport,
  SyncPermissionGap,
} from "./sync-types.js"

// allow: SIZE_OK — a single ordered Canvas course synchronization transaction.
type CourseSyncInput = {
  readonly options: CanvasSyncInput
  readonly writer: VaultWriter
  readonly course: Course
  readonly now: () => Date
}

export async function syncCourse(input: CourseSyncInput): Promise<SyncCourseReport> {
  const courseId = String(input.course.id)
  const courseCode = input.course.course_code ?? `course-${courseId}`
  const course = vaultCourse(input.options, input.course, courseCode)
  const changes: SyncChange[] = []
  const gaps: FileAuditGap[] = []
  const permissionGaps: SyncPermissionGap[] = []
  const startedAt = input.now().toISOString()
  input.options.index.upsertCourse({
    canvasId: input.course.id,
    name: input.course.name ?? null,
    courseCode: input.course.course_code ?? null,
    workflowState: input.course.workflow_state ?? null,
    vaultPath: coursePaths(input.options.vaultPath, courseCode, input.course.id).root,
  })
  const modules = await permissionAware("modules", permissionGaps, courseId, course.canvasUrl, () =>
    listModules(input.options.client, input.course.id),
  )
  const assignments = await permissionAware(
    "assignments",
    permissionGaps,
    courseId,
    course.canvasUrl,
    () => listAssignments(input.options.client, input.course.id),
  )
  const announcements = await permissionAware(
    "announcements",
    permissionGaps,
    courseId,
    course.canvasUrl,
    () => listAnnouncements(input.options.client, input.course.id),
  )
  const calendarEvents = await permissionAware(
    "calendar",
    permissionGaps,
    courseId,
    course.canvasUrl,
    () => listCalendarEvents(input.options.client, input.course.id),
  )
  const syllabus = await permissionAware(
    "syllabus",
    permissionGaps,
    courseId,
    course.canvasUrl,
    () => getSyllabus(input.options.client, input.course.id),
  )
  const files = await permissionAware("files", permissionGaps, courseId, course.canvasUrl, () =>
    listFiles(input.options.client, input.course.id),
  )
  const discussions = await permissionAware(
    "discussions",
    permissionGaps,
    courseId,
    course.canvasUrl,
    () => listDiscussionTopics(input.options.client, input.course.id),
  )
  const quizzes = await permissionAware("quizzes", permissionGaps, courseId, course.canvasUrl, () =>
    listQuizzes(input.options.client, input.course.id),
  )
  const courseYear = resolveCourseYear(
    input.course,
    (assignments ?? []).map((assignment) => assignment.due_at),
  )
  const navigation = createNavigationCollector(input.options, course)
  const skipFileIds = new Set<string>()
  const planningDocuments: NavigationDocument[] = []
  for (const module of modules ?? []) {
    const dates = moduleDates(module, courseYear)
    planningDocuments.push({
      title: module.name ?? `Module ${module.id}`,
      path: `planning/${module.id}.md`,
      type: vaultDocumentKinds.module,
      canvasId: module.id,
      ...(dates === undefined ? {} : { dates }),
    })
  }
  for (const file of files ?? []) {
    if (file.size === undefined || file.updated_at === undefined) continue
    planningDocuments.push({
      title: file.display_name ?? `File ${file.id}`,
      path: `planning/file-${file.id}.md`,
      type: vaultDocumentKinds.file,
      canvasId: file.id,
      dates: {
        created_at: file.created_at ?? file.updated_at ?? null,
        updated_at: file.updated_at ?? null,
      },
    })
  }
  for (const announcement of announcements ?? []) {
    planningDocuments.push({
      title: announcement.title ?? `Announcement ${announcement.id}`,
      path: `planning/announcement-${announcement.id}.md`,
      type: "announcements",
      canvasId: announcement.id,
      dates: { posted_at: announcement.posted_at ?? null },
    })
  }
  const navigationPlan = buildNavigationModel({
    course: { name: input.course.name ?? null, code: courseCode },
    documents: planningDocuments,
    assignments: (assignments ?? []).map((assignment) => ({
      title: assignment.name ?? `Assignment ${assignment.id}`,
      path: `planning/assignment-${assignment.id}.md`,
      canvasId: assignment.id,
      dueAt: assignment.due_at ?? null,
    })),
    now: input.now(),
  })
  const modulePeriods = new Map<string, NavigationPeriod>()
  for (const module of modules ?? []) {
    const dates = moduleDates(module, courseYear)
    const date = navigationDate(
      dates?.["session_at"] ?? dates?.["unlock_at"] ?? dates?.["created_at"],
    )
    const period = navigationPeriodForDate(navigationPlan, date)
    if (period !== null) modulePeriods.set(String(module.id), period)
  }
  const assignmentModuleIds = assignmentModuleMap(modules ?? [])
  const resourceInput: SyncResourceInput = {
    options: input.options,
    writer: input.writer,
    now: input.now,
    canvasCourse: input.course,
    course,
    navigation,
    modulePeriods,
    skipFileIds,
    ...(courseYear === undefined ? {} : { courseYear }),
  }
  if (syllabus !== null) {
    await writeArtifact({
      writer: input.writer,
      course,
      kind: vaultDocumentKinds.syllabus,
      title: "Syllabus",
      canvasId: input.course.id,
      canvasUrl: course.canvasUrl,
      content: renderSyllabus(syllabus),
      navigation,
    })
  }
  await syncSyllabusFiles({
    ...resourceInput,
    syllabusBody: syllabus?.syllabus_body,
    gaps,
    permissionGaps,
  })
  const pages: { readonly page: CanvasPage; readonly module: Module }[] = []
  if (modules !== null)
    await syncModules({ resourceInput, modules, changes, permissionGaps, pages, modulePeriods })
  await syncModuleFiles({ ...resourceInput, modules: modules ?? [], gaps, permissionGaps })
  await syncPageFiles({ ...resourceInput, pages, gaps, permissionGaps })
  if (assignments !== null) {
    await syncAssignmentFiles({
      ...resourceInput,
      assignments,
      gaps,
      permissionGaps,
      assignmentModuleIds,
    })
    await syncAssignments({ resourceInput, assignments, changes, assignmentModuleIds })
  }
  if (announcements !== null) await syncAnnouncements({ resourceInput, announcements })
  if (calendarEvents !== null) {
    for (const event of calendarEvents) {
      input.options.index.upsertCalendarEvent({
        canvasId: event.id,
        courseCanvasId: input.course.id,
        title: event.title ?? null,
        startAt: event.start_at ?? null,
      })
    }
  }
  if (files !== null) await syncFiles({ ...resourceInput, files, gaps, permissionGaps })
  await syncTextResources({
    ...resourceInput,
    discussions: discussions ?? [],
    quizzes: quizzes ?? [],
  })
  const navigationModel = buildNavigationModel({
    course: { name: input.course.name ?? null, code: courseCode },
    documents: navigation.documents,
    now: input.now(),
  })
  for (const artifact of navigationArtifacts(navigationModel)) {
    await input.writer.writeNavigation({
      course,
      path: artifact.path,
      content: artifact.content,
    })
  }
  const tombstones =
    assignments === null
      ? 0
      : input.options.index.tombstoneMissingAssignments(
          courseId,
          assignments.map((assignment) => String(assignment.id)),
        )
  if (tombstones > 0)
    changes.push({
      resource: "tombstone",
      canvasId: courseId,
      detail: `${tombstones} assignment(s)`,
    })
  await input.writer.writeCourseManifest({
    course,
    restrictedFileHandling: input.options.restrictedFileHandling ?? "exclude",
    ...(assignments === null
      ? {}
      : { activeAssignmentIds: assignments.map((assignment) => String(assignment.id)) }),
  })
  input.options.index.upsertSyncRun({
    canvasId: randomUUID(),
    courseCanvasId: courseId,
    startedAt,
    completedAt: input.now().toISOString(),
    status: "completed",
  })
  return { courseId, courseCode, status: "synced", changes, gaps, permissionGaps }
}

async function permissionAware<T>(
  resource: SyncPermissionGap["resource"],
  gaps: SyncPermissionGap[],
  courseId: string,
  canvasUrl: string,
  operation: () => Promise<T>,
): Promise<T | null> {
  try {
    return await operation()
  } catch (error: unknown) {
    const status = permissionDeniedStatus(error)
    if (status !== null) {
      gaps.push({
        resource,
        status,
        courseId,
        canvasUrl,
      })
      return null
    }
    throw error
  }
}

async function syncModules(input: {
  readonly resourceInput: SyncResourceInput
  readonly modules: readonly Module[]
  readonly changes: SyncChange[]
  readonly permissionGaps: SyncPermissionGap[]
  readonly pages: { readonly page: CanvasPage; readonly module: Module }[]
  readonly modulePeriods: ReadonlyMap<string, NavigationPeriod>
}): Promise<void> {
  for (const module of input.modules) {
    const dates = moduleDates(module, input.resourceInput.courseYear)
    const period = input.modulePeriods.get(String(module.id))
    const result = await writeArtifact({
      writer: input.resourceInput.writer,
      course: input.resourceInput.course,
      kind: vaultDocumentKinds.module,
      title: module.name ?? `Module ${module.id}`,
      canvasId: module.id,
      canvasUrl:
        module.html_url ??
        courseUrl(input.resourceInput.options.canvasBaseUrl, input.resourceInput.canvasCourse.id),
      content: renderModule(module),
      ...(dates === undefined ? {} : { dates }),
      module: {
        number: period?.number ?? module.position ?? 0,
        title: module.name ?? `Module ${module.id}`,
      },
      ...(period === undefined
        ? {}
        : {
            period: {
              kind: period.kind,
              number: period.number,
              date: period.startDate,
              title: period.title,
            },
          }),
      moduleCanvasId: module.id,
      bucket: "other",
      ...(input.resourceInput.navigation === undefined
        ? {}
        : { navigation: input.resourceInput.navigation }),
    })
    input.resourceInput.options.index.upsertModule({
      canvasId: module.id,
      courseCanvasId: input.resourceInput.canvasCourse.id,
      name: module.name ?? null,
      position: module.position ?? null,
      vaultPath: result.path,
      items: (module.items ?? [])
        .filter((item) => item.id !== undefined)
        .map((item) => ({
          canvasId: item.id,
          title: item.title ?? null,
          itemType: item.type ?? null,
          contentCanvasId: item.content_id ?? null,
        })),
    })
    await syncModulePages(input.resourceInput, module, input.permissionGaps, input.pages)
    if (result.kind !== "unchanged")
      input.changes.push({
        resource: "module-item",
        canvasId: String(module.id),
        detail: "module updated",
      })
  }
}

async function syncModulePages(
  input: SyncResourceInput,
  module: Module,
  permissionGaps: SyncPermissionGap[],
  pages: { readonly page: CanvasPage; readonly module: Module }[],
): Promise<void> {
  for (const item of module.items ?? []) {
    if (item.type !== "Page" || item.page_url === undefined) continue
    const pageUrl = item.page_url
    const courseHome = courseUrl(input.options.canvasBaseUrl, input.canvasCourse.id)
    const page = await permissionAware(
      "pages",
      permissionGaps,
      String(input.canvasCourse.id),
      courseHome,
      () => getModulePage(input.options.client, input.canvasCourse.id, pageUrl),
    )
    if (page === null) continue
    const canvasUrl = `${courseHome}/pages/${encodeURIComponent(page.url)}`
    const dates = moduleDates(module, input.courseYear)
    const period = input.modulePeriods?.get(String(module.id))
    await writeArtifact({
      writer: input.writer,
      course: input.course,
      kind: vaultDocumentKinds.module,
      title: page.title ?? item.title ?? page.url,
      canvasId: page.page_id,
      canvasUrl,
      content: renderPage(page),
      ...(dates === undefined ? {} : { dates }),
      module: {
        number: period?.number ?? module.position ?? 0,
        title: module.name ?? `Module ${module.id}`,
        canvasId: module.id,
      },
      moduleCanvasId: module.id,
      ...(period === undefined
        ? {}
        : {
            period: {
              kind: period.kind,
              number: period.number,
              date: period.startDate,
              title: period.title,
            },
          }),
      bucket: classifyNavigationBucket(
        page.title ?? item.title ?? page.url,
        renderPage(page),
        "page",
      ),
      ...(input.navigation === undefined ? {} : { navigation: input.navigation }),
    })
    pages.push({ page, module })
  }
}

async function syncAssignments(input: {
  readonly resourceInput: SyncResourceInput
  readonly assignments: readonly Assignment[]
  readonly changes: SyncChange[]
  readonly assignmentModuleIds: ReadonlyMap<string, string>
}): Promise<void> {
  for (const assignment of input.assignments) {
    const previousDueAt = input.resourceInput.options.index.effectiveDueDate(String(assignment.id))
    const moduleCanvasId = input.assignmentModuleIds.get(String(assignment.id))
    const result = await writeArtifact({
      writer: input.resourceInput.writer,
      course: input.resourceInput.course,
      kind: vaultDocumentKinds.assignment,
      title: assignment.name ?? `Assignment ${assignment.id}`,
      canvasId: assignment.id,
      canvasUrl:
        assignment.html_url ??
        courseUrl(input.resourceInput.options.canvasBaseUrl, input.resourceInput.canvasCourse.id),
      content: renderAssignment(assignment),
      dates: {
        due_at: assignment.due_at ?? null,
        created_at: assignment.created_at ?? null,
        unlock_at: assignment.unlock_at ?? null,
      },
      ...(moduleCanvasId === undefined ? {} : { moduleCanvasId }),
      assignment: {
        title: assignment.name ?? `Assignment ${assignment.id}`,
        dueAt: assignment.due_at ?? null,
      },
      ...(input.resourceInput.navigation === undefined
        ? {}
        : { navigation: input.resourceInput.navigation }),
    })
    input.resourceInput.options.index.upsertAssignment({
      canvasId: assignment.id,
      courseCanvasId: input.resourceInput.canvasCourse.id,
      name: assignment.name ?? null,
      dueAt: assignment.due_at ?? null,
      vaultPath: result.path,
      allDates: (assignment.all_dates ?? []).map((date, index) => ({
        canvasId: `${assignment.id}:${date.id ?? index}`,
        dueAt: date.due_at ?? null,
        isUserOverride: date.base !== true,
      })),
      deleted: false,
    })
    const currentDueAt = input.resourceInput.options.index.effectiveDueDate(String(assignment.id))
    if (previousDueAt !== null && previousDueAt.dueAt !== currentDueAt?.dueAt)
      input.changes.push({
        resource: "assignment",
        canvasId: String(assignment.id),
        detail: "due date changed",
      })
    await syncFeedback({ ...input.resourceInput, assignment, changes: input.changes })
  }
}

async function syncAnnouncements(input: {
  readonly resourceInput: SyncResourceInput
  readonly announcements: readonly Announcement[]
}): Promise<void> {
  for (const announcement of input.announcements) {
    const result = await writeArtifact({
      writer: input.resourceInput.writer,
      course: input.resourceInput.course,
      kind: vaultDocumentKinds.announcement,
      title: announcement.title ?? `Announcement ${announcement.id}`,
      canvasId: announcement.id,
      canvasUrl:
        announcement.html_url ??
        courseUrl(input.resourceInput.options.canvasBaseUrl, input.resourceInput.canvasCourse.id),
      content: renderAnnouncement(announcement),
      dates: { posted_at: announcement.posted_at ?? null },
      ...(input.resourceInput.navigation === undefined
        ? {}
        : { navigation: input.resourceInput.navigation }),
    })
    input.resourceInput.options.index.upsertAnnouncement({
      canvasId: announcement.id,
      courseCanvasId: input.resourceInput.canvasCourse.id,
      title: announcement.title ?? null,
      postedAt: announcement.posted_at ?? null,
      vaultPath: result.path,
    })
  }
}

/**
 * Maps an assignment's canvas_id to the canvas_id of the module that
 * references it (an Assignment-type module item's `content_id`), so the
 * assignment doc — and any file recovered from its description — can carry
 * `module_canvas_id` even though the module list was already fetched
 * separately from the assignment list.
 */
function assignmentModuleMap(modules: readonly Module[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const module of modules) {
    for (const item of module.items ?? []) {
      if (item.type === "Assignment" && item.content_id !== undefined) {
        map.set(String(item.content_id), String(module.id))
      }
    }
  }
  return map
}

function vaultCourse(options: CanvasSyncInput, course: Course, courseCode: string): VaultCourse {
  return {
    code: courseCode,
    canvasId: course.id,
    canvasUrl: courseUrl(options.canvasBaseUrl, course.id),
    aiPolicy: options.courseAiPolicies?.[String(course.id)] ?? "allowed",
  }
}

function createNavigationCollector(
  options: CanvasSyncInput,
  course: VaultCourse,
): SyncNavigationCollector {
  return {
    courseRoot: coursePaths(options.vaultPath, course.code, course.canvasId).root,
    documents: [],
  }
}

function classifyNavigationBucket(
  title: string,
  content: string,
  type: string,
): "prep" | "materials" | "other" {
  return classifyNavigationItem({ title, path: "", type, content })
}
