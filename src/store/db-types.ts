import { z } from "zod"

const canvasIdSchema = z.union([z.string().min(1), z.number().finite()]).transform(String)
const optionalTextSchema = z.string().nullable().default(null)

const courseSchema = z.strictObject({
  canvasId: canvasIdSchema,
  name: optionalTextSchema,
  courseCode: optionalTextSchema,
  workflowState: optionalTextSchema,
  vaultPath: optionalTextSchema,
})
const moduleItemSchema = z.strictObject({
  canvasId: canvasIdSchema,
  title: optionalTextSchema,
  itemType: optionalTextSchema,
  contentCanvasId: canvasIdSchema.nullable().default(null),
})
const moduleSchema = z.strictObject({
  canvasId: canvasIdSchema,
  courseCanvasId: canvasIdSchema,
  name: optionalTextSchema,
  position: z.number().int().nonnegative().nullable().default(null),
  vaultPath: optionalTextSchema,
  items: z.array(moduleItemSchema).default([]),
})
const assignmentDateSchema = z.strictObject({
  canvasId: canvasIdSchema,
  dueAt: optionalTextSchema,
  isUserOverride: z.boolean().default(false),
})
const assignmentSchema = z.strictObject({
  canvasId: canvasIdSchema,
  courseCanvasId: canvasIdSchema,
  name: optionalTextSchema,
  dueAt: optionalTextSchema,
  vaultPath: optionalTextSchema,
  allDates: z.array(assignmentDateSchema).default([]),
  deleted: z.boolean().default(false),
})
const announcementSchema = z.strictObject({
  canvasId: canvasIdSchema,
  courseCanvasId: canvasIdSchema,
  title: optionalTextSchema,
  postedAt: optionalTextSchema,
  vaultPath: optionalTextSchema,
})
const calendarEventSchema = z.strictObject({
  canvasId: canvasIdSchema,
  courseCanvasId: canvasIdSchema,
  title: optionalTextSchema,
  startAt: optionalTextSchema,
})
const fileSchema = z.strictObject({
  canvasId: canvasIdSchema,
  courseCanvasId: canvasIdSchema,
  displayName: optionalTextSchema,
  url: optionalTextSchema,
  vaultPath: optionalTextSchema,
})
const submissionSchema = z.strictObject({
  canvasId: canvasIdSchema,
  assignmentCanvasId: canvasIdSchema,
  courseCanvasId: canvasIdSchema,
  workflowState: optionalTextSchema,
  submittedAt: optionalTextSchema,
})
const syncRunSchema = z.strictObject({
  canvasId: canvasIdSchema,
  courseCanvasId: canvasIdSchema,
  startedAt: z.string().min(1),
  completedAt: optionalTextSchema,
  status: z.string().min(1),
})
const tokenUsageSchema = z.strictObject({
  syncRunCanvasId: canvasIdSchema,
  model: z.string().min(1),
  functionName: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  // Defaulted (not required) so pre-Stage-B callers/fixtures keep working:
  // `''` matches the migration's default for existing undated rows and is
  // excluded from month-to-date windows (see `costSummary`/`assertUnderSpendCap`).
  recordedAt: z.string().default(""),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  // The AI Gateway's per-call generation id (see AgentRunUsage), nullable —
  // absent for non-gateway calls and for rows written before this field
  // existed. `costSource` is "estimate" (local price-table math, the
  // default) or "gateway" (overwritten by `cost reconcile` with the
  // gateway's authoritative totalCost); nullable so a pre-migration row
  // reads as "estimate" without needing a backfill.
  generationId: z.string().nullable().default(null),
  costSource: z.enum(["estimate", "gateway"]).nullable().default("estimate"),
})
const metadataSchema = z.strictObject({ key: z.string().min(1), value: z.string() })

export const schoolIndexSnapshotSchema = z.strictObject({
  course: courseSchema,
  modules: z.array(moduleSchema).default([]),
  assignments: z.array(assignmentSchema).default([]),
  announcements: z.array(announcementSchema).default([]),
  calendarEvents: z.array(calendarEventSchema).default([]),
  files: z.array(fileSchema).default([]),
  submissions: z.array(submissionSchema).default([]),
  syncRun: syncRunSchema,
  tokenUsage: z.array(tokenUsageSchema).default([]),
  metadata: z.array(metadataSchema).default([]),
})

export type CourseInput = z.infer<typeof courseSchema>
export type ModuleInput = z.infer<typeof moduleSchema>
export type AssignmentInput = z.infer<typeof assignmentSchema>
export type AnnouncementInput = z.infer<typeof announcementSchema>
export type CalendarEventInput = z.infer<typeof calendarEventSchema>
export type FileInput = z.infer<typeof fileSchema>
export type SubmissionInput = z.infer<typeof submissionSchema>
export type SyncRunInput = z.infer<typeof syncRunSchema>
export type TokenUsageInput = z.infer<typeof tokenUsageSchema>
export type MetadataInput = z.infer<typeof metadataSchema>
export type SchoolIndexSnapshot = z.infer<typeof schoolIndexSnapshotSchema>

export const schoolIndexInputSchemas = {
  course: courseSchema,
  module: moduleSchema,
  assignment: assignmentSchema,
  announcement: announcementSchema,
  calendarEvent: calendarEventSchema,
  file: fileSchema,
  submission: submissionSchema,
  syncRun: syncRunSchema,
  tokenUsage: tokenUsageSchema,
  metadata: metadataSchema,
} as const

export type IndexCounts = {
  readonly courses: number
  readonly modules: number
  readonly moduleItems: number
  readonly assignments: number
  readonly assignmentDates: number
  readonly announcements: number
  readonly calendarEvents: number
  readonly files: number
  readonly submissions: number
  readonly syncRuns: number
  readonly tokenUsage: number
  readonly kvMeta: number
}

export type EffectiveDueDate =
  | { readonly bucket: "dated"; readonly dueAt: string }
  | { readonly bucket: "undated"; readonly dueAt: null }

export type IndexedTimelineEntry =
  | {
      readonly kind: "assignment"
      readonly canvasId: string
      readonly courseCanvasId: string
      readonly courseCode: string
      readonly title: string
      readonly dueAt: string | null
    }
  | {
      readonly kind: "announcement"
      readonly canvasId: string
      readonly courseCanvasId: string
      readonly courseCode: string
      readonly title: string
      readonly postedAt: string | null
    }

export type IndexedFileMetadata = {
  readonly canvasId: string
  readonly courseCanvasId: string
  readonly displayName: string | null
  readonly url: string | null
  readonly vaultPath: string | null
}

export type IndexedTokenUsage = {
  readonly syncRunCanvasId: string
  readonly model: string
  readonly functionName: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly recordedAt: string
  readonly cachedInputTokens: number
  readonly generationId: string | null
  readonly costSource: "estimate" | "gateway"
}

export type CostSummaryGroup = {
  readonly functionName: string
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens: number
  readonly costUsd: number
  /**
   * "estimate" (local price-table math) or "gateway" (reconciled against the
   * AI Gateway's authoritative cost via `cost reconcile`). Grouping includes
   * this, so a function/model with a mix of reconciled and unreconciled rows
   * surfaces as two separate group rows rather than blending sources.
   */
  readonly costSource: "estimate" | "gateway"
}

/** One `token_usage` row eligible for `cost reconcile`: a non-null generation id. */
export type ReconciliationCandidate = {
  readonly syncRunCanvasId: string
  readonly model: string
  readonly functionName: string
  readonly generationId: string
}

export type CostSummary = {
  readonly groups: readonly CostSummaryGroup[]
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly totalCachedInputTokens: number
  readonly totalCostUsd: number
}

export type IndexedCourse = {
  readonly canvasId: string
  readonly courseCode: string
}

export type IndexedCalendarEvent = {
  readonly canvasId: string
  readonly courseCanvasId: string
  readonly title: string | null
  readonly startAt: string | null
}
