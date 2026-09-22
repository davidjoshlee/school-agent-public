import type { SchoolConfig } from "../config/index.js"
import type { DueSoonNotifier } from "../engines/timeline.js"
import type { SchoolIndex } from "../store/db.js"
import type { Course } from "./endpoints.js"
import type { FileAuditGap } from "./files.js"
import type { CanvasHttpClient } from "./http.js"

export type SyncCourseStatus = "synced" | "failed"

export type SyncPermissionGap = {
  readonly resource:
    | "modules"
    | "assignments"
    | "announcements"
    | "calendar"
    | "syllabus"
    | "files"
    | "discussions"
    | "quizzes"
    | "pages"
  readonly status: 403 | 404
  readonly courseId: string
  readonly canvasUrl: string
}

export type SyncChange = {
  readonly resource: "assignment" | "module-item" | "tombstone" | "feedback"
  readonly canvasId: string
  readonly detail: string
}

export type SyncCourseReport = {
  readonly courseId: string
  readonly courseCode: string
  readonly status: SyncCourseStatus
  readonly changes: readonly SyncChange[]
  readonly gaps: readonly FileAuditGap[]
  readonly permissionGaps: readonly SyncPermissionGap[]
  readonly error?: string
}

export type CanvasSyncReport = {
  readonly discoveredCourseIds: readonly string[]
  readonly courses: readonly SyncCourseReport[]
}

export type CanvasSyncInput = {
  readonly client: CanvasHttpClient
  readonly canvasBaseUrl: string
  readonly vaultPath: string
  readonly index: SchoolIndex
  readonly gitInit: boolean
  readonly maxFileSizeMB: number
  readonly restrictedFileHandling?: SchoolConfig["restrictedFileHandling"]
  readonly full?: boolean
  readonly courseIds?: readonly string[]
  readonly courseOverrides?: Readonly<Record<string, Course>>
  readonly courseAiPolicies?: Readonly<Record<string, "allowed" | "prohibited">>
  readonly now?: () => Date
  readonly leadDays?: number
  readonly dueSoonNotifier?: DueSoonNotifier
}
