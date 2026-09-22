import { z } from "zod"

const CanvasIdSchema = z.union([z.string(), z.number()])
const CanvasObjectSchema = z
  .object({
    id: CanvasIdSchema.optional(),
    title: z.string().optional(),
    type: z.string().optional(),
    content_id: CanvasIdSchema.optional(),
    page_url: z.string().optional(),
    position: z.number().int().nonnegative().optional(),
    due_at: z.string().nullable().optional(),
    base: z.boolean().optional(),
    comment: z.string().optional(),
    html_url: z.string().optional(),
  })
  .passthrough()

export const CourseSchema = z
  .object({
    id: CanvasIdSchema,
    name: z.string().optional(),
    course_code: z.string().optional(),
    concluded: z.boolean().optional(),
    workflow_state: z.string().optional(),
    syllabus_body: z.string().nullable().optional(),
    updated_at: z.string().optional(),
    start_at: z.string().nullable().optional(),
    end_at: z.string().nullable().optional(),
    term: z
      .object({
        start_at: z.string().nullable().optional(),
        end_at: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()
export const ModuleSchema = z
  .object({
    id: CanvasIdSchema,
    name: z.string().optional(),
    position: z.number().int().nonnegative().optional(),
    unlock_at: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().optional(),
    html_url: z.string().optional(),
    items: z.array(CanvasObjectSchema).optional(),
  })
  .passthrough()
export const AssignmentSchema = z
  .object({
    id: CanvasIdSchema,
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    due_at: z.string().nullable().optional(),
    unlock_at: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().optional(),
    html_url: z.string().optional(),
    has_overrides: z.boolean().optional(),
    all_dates: z.array(CanvasObjectSchema).optional(),
    rubric: z.array(CanvasObjectSchema).nullable().optional(),
    submission: CanvasObjectSchema.nullable().optional(),
    group_category_id: CanvasIdSchema.nullable().optional(),
  })
  .passthrough()
export const AnnouncementSchema = z
  .object({
    id: CanvasIdSchema,
    title: z.string().optional(),
    message: z.string().optional(),
    posted_at: z.string().nullable().optional(),
    updated_at: z.string().optional(),
    html_url: z.string().optional(),
  })
  .passthrough()
export const PageSchema = z
  .object({
    page_id: CanvasIdSchema,
    url: z.string(),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    updated_at: z.string().optional(),
    html_url: z.string().optional(),
  })
  .passthrough()
export const FileSchema = z
  .object({
    id: CanvasIdSchema,
    display_name: z.string().optional(),
    url: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    updated_at: z.string().optional(),
    created_at: z.string().optional(),
    content_type: z.string().optional(),
  })
  .passthrough()
  // Canvas names the field `content-type` (hyphen); normalize it onto `content_type`
  // so downstream consumers read one canonical key. Extra keys are still preserved.
  .transform((file) => {
    if (file.content_type !== undefined) return file
    const hyphenated = (file as Readonly<Record<string, unknown>>)["content-type"]
    return typeof hyphenated === "string" ? { ...file, content_type: hyphenated } : file
  })
export const PlannerItemSchema = z
  .object({ plannable_id: CanvasIdSchema.optional(), plannable_type: z.string().optional() })
  .passthrough()
export const CalendarEventSchema = z
  .object({
    id: CanvasIdSchema,
    title: z.string().optional(),
    start_at: z.string().nullable().optional(),
  })
  .passthrough()
export const DiscussionTopicSchema = z
  .object({
    id: CanvasIdSchema,
    title: z.string().optional(),
    message: z.string().nullable().optional(),
    html_url: z.string().optional(),
  })
  .passthrough()
export const QuizSchema = z
  .object({
    id: CanvasIdSchema,
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    html_url: z.string().optional(),
  })
  .passthrough()
export const QuizQuestionSchema = z.object({ id: CanvasIdSchema }).passthrough()
export const OwnSubmissionSchema = z
  .object({
    id: CanvasIdSchema,
    assignment_id: CanvasIdSchema,
    workflow_state: z.string().optional(),
    submitted_at: z.string().nullable().optional(),
    score: z.number().nullable().optional(),
    graded_at: z.string().nullable().optional(),
    rubric_assessment: z.record(z.string(), z.unknown()).nullable().optional(),
    submission_history: z.array(CanvasObjectSchema).optional(),
    submission_comments: z.array(CanvasObjectSchema).optional(),
    attachments: z.array(CanvasObjectSchema).optional(),
  })
  .passthrough()

export type CanvasId = z.infer<typeof CanvasIdSchema>
export type Course = z.infer<typeof CourseSchema>
export type Module = z.infer<typeof ModuleSchema>
export type Assignment = z.infer<typeof AssignmentSchema>
export type Announcement = z.infer<typeof AnnouncementSchema>
export type CanvasPage = z.infer<typeof PageSchema>
export type CanvasFile = z.infer<typeof FileSchema>
export type PlannerItem = z.infer<typeof PlannerItemSchema>
export type CalendarEvent = z.infer<typeof CalendarEventSchema>
export type DiscussionTopic = z.infer<typeof DiscussionTopicSchema>
export type Quiz = z.infer<typeof QuizSchema>
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>
export type OwnSubmission = z.infer<typeof OwnSubmissionSchema>
