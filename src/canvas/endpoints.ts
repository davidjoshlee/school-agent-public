import { z } from "zod"

import type {
  Announcement,
  Assignment,
  CalendarEvent,
  CanvasFile,
  CanvasId,
  CanvasPage,
  Course,
  DiscussionTopic,
  Module,
  OwnSubmission,
  PlannerItem,
  Quiz,
  QuizQuestion,
} from "./endpoint-schemas.js"
import {
  AnnouncementSchema,
  AssignmentSchema,
  CalendarEventSchema,
  CourseSchema,
  DiscussionTopicSchema,
  FileSchema,
  ModuleSchema,
  OwnSubmissionSchema,
  PageSchema,
  PlannerItemSchema,
  QuizQuestionSchema,
  QuizSchema,
} from "./endpoint-schemas.js"
import type { CanvasHttpClient } from "./http.js"

export type {
  Announcement,
  Assignment,
  CalendarEvent,
  CanvasFile,
  CanvasId,
  CanvasPage,
  Course,
  DiscussionTopic,
  Module,
  OwnSubmission,
  PlannerItem,
  Quiz,
  QuizQuestion,
} from "./endpoint-schemas.js"
export {
  AnnouncementSchema,
  AssignmentSchema,
  CalendarEventSchema,
  CourseSchema,
  DiscussionTopicSchema,
  FileSchema,
  ModuleSchema,
  OwnSubmissionSchema,
  PageSchema,
  PlannerItemSchema,
  QuizQuestionSchema,
  QuizSchema,
} from "./endpoint-schemas.js"
export { CANVAS_READ_ROUTES } from "./read-routes.js"

// allow: SIZE_OK — a single Canvas API endpoint registry (one small typed wrapper per resource);
// it grows by adding a resource, never by adding logic to an existing wrapper.
export const CourseEnrollmentStates = ["active", "completed"] as const
export type CourseEnrollmentState = (typeof CourseEnrollmentStates)[number]

function coursePath(courseId: CanvasId): string {
  return `/api/v1/courses/${encodeURIComponent(String(courseId))}`
}

function endpoint(path: string, parameters: readonly (readonly [string, string])[]): string {
  const search = new URLSearchParams()
  for (const [key, value] of parameters) {
    search.append(key, value)
  }
  return `${path}?${search.toString()}`
}

async function collection<T>(
  client: CanvasHttpClient,
  path: string,
  schema: z.ZodType<T>,
): Promise<readonly T[]> {
  const values: T[] = []
  for await (const response of client.paginate(path)) {
    values.push(...z.array(schema).parse(await response.json()))
  }
  return values
}

async function resource<T>(
  client: CanvasHttpClient,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  return schema.parse(await (await client.get(path)).json())
}

export function listCourses(
  client: CanvasHttpClient,
  enrollmentState: CourseEnrollmentState,
): Promise<readonly Course[]> {
  const state: readonly (readonly [string, string])[] =
    enrollmentState === "completed" ? [["state[]", "completed"]] : []
  return collection(
    client,
    endpoint("/api/v1/courses", [
      ["enrollment_state", enrollmentState],
      ...state,
      ["include[]", "term"],
      ["include[]", "calendar"],
      ["include[]", "concluded"],
    ]),
    CourseSchema,
  )
}

export function listModules(
  client: CanvasHttpClient,
  courseId: CanvasId,
): Promise<readonly Module[]> {
  return collection(
    client,
    endpoint(`${coursePath(courseId)}/modules`, [
      ["include[]", "items"],
      ["include[]", "content_details"],
    ]),
    ModuleSchema,
  )
}

export function listAssignments(
  client: CanvasHttpClient,
  courseId: CanvasId,
): Promise<readonly Assignment[]> {
  return collection(
    client,
    endpoint(`${coursePath(courseId)}/assignments`, [
      ["include[]", "all_dates"],
      ["include[]", "rubric"],
      ["include[]", "submission"],
    ]),
    AssignmentSchema,
  )
}

export function listAnnouncements(
  client: CanvasHttpClient,
  courseId: CanvasId,
): Promise<readonly Announcement[]> {
  return collection(
    client,
    endpoint("/api/v1/announcements", [["context_codes[]", `course_${courseId}`]]),
    AnnouncementSchema,
  )
}

export function getSyllabus(client: CanvasHttpClient, courseId: CanvasId): Promise<Course> {
  return resource(
    client,
    endpoint(coursePath(courseId), [["include[]", "syllabus_body"]]),
    CourseSchema,
  )
}

export function getModulePage(
  client: CanvasHttpClient,
  courseId: CanvasId,
  pageUrl: string,
): Promise<CanvasPage> {
  return resource(
    client,
    endpoint(`${coursePath(courseId)}/pages/${encodeURIComponent(pageUrl)}`, [
      ["include[]", "body"],
    ]),
    PageSchema,
  )
}

export function listFiles(
  client: CanvasHttpClient,
  courseId: CanvasId,
): Promise<readonly CanvasFile[]> {
  return collection(client, `${coursePath(courseId)}/files`, FileSchema)
}

export function getFile(
  client: CanvasHttpClient,
  courseId: CanvasId,
  fileId: CanvasId,
): Promise<CanvasFile> {
  return resource(
    client,
    `${coursePath(courseId)}/files/${encodeURIComponent(String(fileId))}`,
    FileSchema,
  )
}

export function listPlannerItems(
  client: CanvasHttpClient,
  courseId: CanvasId,
): Promise<readonly PlannerItem[]> {
  return collection(
    client,
    endpoint("/api/v1/planner/items", [["context_codes[]", `course_${courseId}`]]),
    PlannerItemSchema,
  )
}

export function listCalendarEvents(
  client: CanvasHttpClient,
  courseId: CanvasId,
): Promise<readonly CalendarEvent[]> {
  return collection(
    client,
    endpoint("/api/v1/calendar_events", [["context_codes[]", `course_${courseId}`]]),
    CalendarEventSchema,
  )
}

export function listDiscussionTopics(
  client: CanvasHttpClient,
  courseId: CanvasId,
): Promise<readonly DiscussionTopic[]> {
  return collection(client, `${coursePath(courseId)}/discussion_topics`, DiscussionTopicSchema)
}

export function listQuizzes(
  client: CanvasHttpClient,
  courseId: CanvasId,
): Promise<readonly Quiz[]> {
  return collection(client, `${coursePath(courseId)}/quizzes`, QuizSchema)
}

export function getQuiz(
  client: CanvasHttpClient,
  courseId: CanvasId,
  quizId: CanvasId,
): Promise<Quiz> {
  return resource(
    client,
    `${coursePath(courseId)}/quizzes/${encodeURIComponent(String(quizId))}`,
    QuizSchema,
  )
}

export function listQuizQuestions(
  client: CanvasHttpClient,
  courseId: CanvasId,
  quizId: CanvasId,
): Promise<readonly QuizQuestion[]> {
  return collection(
    client,
    `${coursePath(courseId)}/quizzes/${encodeURIComponent(String(quizId))}/questions`,
    QuizQuestionSchema,
  )
}

export function dedupeCoursesById(...lists: readonly (readonly Course[])[]): Course[] {
  return [...new Map(lists.flat().map((course) => [String(course.id), course])).values()]
}

export function getOwnSubmission(
  client: CanvasHttpClient,
  courseId: CanvasId,
  assignmentId: CanvasId,
): Promise<OwnSubmission> {
  return resource(
    client,
    endpoint(
      `${coursePath(courseId)}/assignments/${encodeURIComponent(String(assignmentId))}/submissions/self`,
      [
        ["include[]", "submission_history"],
        ["include[]", "rubric_assessment"],
        ["include[]", "submission_comments"],
        ["include[]", "attachments"],
      ],
    ),
    OwnSubmissionSchema,
  )
}
