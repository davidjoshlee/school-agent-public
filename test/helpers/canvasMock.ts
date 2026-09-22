import { HttpResponse, http, type PathParams } from "msw"
import { type SetupServer, setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll } from "vitest"

import { canvasBaseUrl } from "./schoolConfig.js"

/**
 * The single msw server shared by every Canvas-backed test. Importing this
 * module registers the file-scoped `beforeAll` / `afterEach` / `afterAll`
 * lifecycle for the importing test file, so callers only need to add their
 * per-test `server.use(...)` overrides.
 */
export const server: SetupServer = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

export type MockCourse = {
  readonly id: string
  readonly name: string
  readonly course_code: string
  readonly concluded?: boolean
  readonly workflow_state?: string
  readonly syllabus_body?: string
}

export type MockModuleItem = {
  readonly id: string
  readonly title: string
  readonly type: string
  readonly page_url?: string
  readonly content_id?: string
}

export type MockModule = {
  readonly id: string
  readonly name: string
  readonly position: number
  readonly items?: readonly MockModuleItem[]
}

export type MockAssignment = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly due_at?: string | null
  readonly created_at?: string | null
  readonly unlock_at?: string | null
  readonly updated_at?: string
  readonly all_dates?: readonly unknown[]
  readonly html_url?: string
}

export type MockSubmission = {
  readonly id: string
  readonly assignment_id: string
  readonly workflow_state: string
  readonly score?: number | null
  readonly rubric_assessment?: Readonly<Record<string, unknown>>
  readonly submission_comments?: readonly Readonly<Record<string, unknown>>[]
}

export type MockPage = {
  readonly page_id: string
  readonly url: string
  readonly title: string
  readonly body: string
}

export type MockFile = {
  readonly id: string
  readonly display_name: string
  readonly url?: string
  readonly size?: number
  readonly updated_at?: string
  readonly content_type?: string
}

export type MockCourseResource =
  | "modules"
  | "assignments"
  | "syllabus"
  | "pages"
  | "files"
  | "announcements"
  | "calendar_events"
  | "discussion_topics"
  | "quizzes"
  | "submissions"

export type MockCourseHandlersConfig = {
  readonly baseUrl?: string
  readonly course?: MockCourse
  readonly modules?: readonly MockModule[]
  readonly assignments?: readonly MockAssignment[]
  readonly submissions?: Readonly<Record<string, MockSubmission>>
  readonly pages?: Readonly<Record<string, MockPage>>
  readonly files?: readonly MockFile[]
  readonly announcements?: readonly unknown[]
  readonly calendarEvents?: readonly unknown[]
  readonly discussions?: readonly unknown[]
  readonly quizzes?: readonly unknown[]
  /** Resource name → HTTP status to return instead of the success body. */
  readonly forbidden?: Partial<Readonly<Record<MockCourseResource, number>>>
}

const defaultCourse: MockCourse = {
  id: "1",
  name: "Pricing",
  course_code: "FIN-101",
  syllabus_body: "Syllabus",
}

const defaultModules: readonly MockModule[] = [
  {
    id: "11",
    name: "Week 1",
    position: 1,
    items: [{ id: "111", title: "Intro", type: "Page", page_url: "intro" }],
  },
]

const defaultAssignments: readonly MockAssignment[] = [
  {
    id: "21",
    name: "Case memo",
    description: "Apply the framework.",
    due_at: "2026-10-01T17:00:00Z",
    updated_at: "2026-09-01T17:00:00Z",
    all_dates: [],
    html_url: `${canvasBaseUrl}/courses/1/assignments/21`,
  },
  {
    id: "22",
    name: "Problem set",
    description: "Calculate the result.",
    due_at: "2026-10-03T17:00:00Z",
    updated_at: "2026-09-01T17:00:00Z",
    all_dates: [],
    html_url: `${canvasBaseUrl}/courses/1/assignments/22`,
  },
]

const defaultSubmissions: Readonly<Record<string, MockSubmission>> = {
  "21": {
    id: "61",
    assignment_id: "21",
    workflow_state: "graded",
    score: 92,
    rubric_assessment: { criterion: { points: 9, comments: "Strong synthesis" } },
    submission_comments: [{ comment: "Use evidence earlier." }],
  },
  "22": { id: "62", assignment_id: "22", workflow_state: "unsubmitted" },
}

const defaultPages: Readonly<Record<string, MockPage>> = {
  intro: { page_id: "41", url: "intro", title: "Intro", body: "Welcome page" },
}

const defaultFiles: readonly MockFile[] = [
  {
    id: "51",
    display_name: "lecture.pdf",
    url: `${canvasBaseUrl}/files/51`,
    size: 1_048_577,
    updated_at: "2026-09-01T17:00:00Z",
  },
]

const defaultAnnouncements: readonly unknown[] = [
  { id: "31", title: "Welcome", message: "Read the case.", posted_at: "2026-09-01T17:00:00Z" },
]

const defaultCalendarEvents: readonly unknown[] = [
  { id: "71", title: "Session 1", start_at: "2026-09-01T17:00:00Z" },
]

const defaultDiscussions: readonly unknown[] = []

const defaultQuizzes: readonly unknown[] = []

function listItem(course: MockCourse): Readonly<Record<string, string>> {
  const item: Record<string, string> = {
    id: course.id,
    name: course.name,
    course_code: course.course_code,
  }
  if (course.concluded !== undefined) {
    item.concluded = String(course.concluded)
  }
  if (course.workflow_state !== undefined) {
    item.workflow_state = course.workflow_state
  }
  return item
}

function denied(status: number): HttpResponse {
  return new HttpResponse(null, { status })
}

function syllabusBody(course: MockCourse): Readonly<Record<string, string>> {
  const body: Record<string, string> = {
    id: course.id,
    name: course.name,
    course_code: course.course_code,
  }
  if (course.concluded !== undefined) {
    body.concluded = String(course.concluded)
  }
  if (course.workflow_state !== undefined) {
    body.workflow_state = course.workflow_state
  }
  if (course.syllabus_body !== undefined) {
    body.syllabus_body = course.syllabus_body
  }
  return body
}

/**
 * Install the canonical deterministic Canvas route handlers shared by the
 * course tests. Defaults reproduce the richest baseline (the one
 * `sync.test.ts` used to inline): course "1" (FIN-101) with one module, two
 * dated assignments, one announcement, one calendar event, one course page, one
 * file, and two own submissions.
 *
 * Callers configure a specific corpus by passing a {@link MockCourseHandlersConfig};
 * the same {@link server} still accepts per-test `server.use(...)` overrides
 * (handlers registered later take precedence) for the bespoke 403 / mutation /
 * ended-course scenarios.
 */
export function installCourseHandlers(config: MockCourseHandlersConfig = {}): void {
  const baseUrl = config.baseUrl ?? canvasBaseUrl
  const course = config.course ?? defaultCourse
  const modules = config.modules ?? defaultModules
  const assignments = config.assignments ?? defaultAssignments
  const submissions = config.submissions ?? defaultSubmissions
  const pages = config.pages ?? defaultPages
  const files = config.files ?? defaultFiles
  const announcements = config.announcements ?? defaultAnnouncements
  const calendarEvents = config.calendarEvents ?? defaultCalendarEvents
  const discussions = config.discussions ?? defaultDiscussions
  const quizzes = config.quizzes ?? defaultQuizzes
  const forbidden = config.forbidden ?? {}

  server.use(
    http.get(`${baseUrl}/api/v1/courses`, () => HttpResponse.json([listItem(course)])),
    http.get(`${baseUrl}/api/v1/courses/:id`, () =>
      forbidden.syllabus !== undefined
        ? denied(forbidden.syllabus)
        : HttpResponse.json(syllabusBody(course)),
    ),
    http.get(`${baseUrl}/api/v1/courses/:id/modules`, () =>
      forbidden.modules !== undefined ? denied(forbidden.modules) : HttpResponse.json(modules),
    ),
    http.get(`${baseUrl}/api/v1/courses/:id/assignments`, () =>
      forbidden.assignments !== undefined
        ? denied(forbidden.assignments)
        : HttpResponse.json(assignments),
    ),
    http.get(
      `${baseUrl}/api/v1/courses/:id/assignments/:assignmentId/submissions/self`,
      ({ params }: { params: PathParams }) =>
        forbidden.submissions !== undefined
          ? denied(forbidden.submissions)
          : HttpResponse.json(submissions[String(params.assignmentId)] ?? {}),
    ),
    http.get(
      `${baseUrl}/api/v1/courses/:id/pages/:pageUrl`,
      ({ params }: { params: PathParams }) =>
        forbidden.pages !== undefined
          ? denied(forbidden.pages)
          : HttpResponse.json(pages[String(params.pageUrl)] ?? {}),
    ),
    http.get(`${baseUrl}/api/v1/courses/:id/files`, () =>
      forbidden.files !== undefined ? denied(forbidden.files) : HttpResponse.json(files),
    ),
    http.get(
      `${baseUrl}/api/v1/courses/:id/files/:fileId`,
      ({ params }: { params: PathParams }) => {
        const file = files.find((entry) => String(entry.id) === String(params.fileId))
        return file === undefined
          ? new HttpResponse(null, { status: 404 })
          : HttpResponse.json(file)
      },
    ),
    http.get(`${baseUrl}/api/v1/courses/:id/discussion_topics`, () =>
      forbidden.discussion_topics !== undefined
        ? denied(forbidden.discussion_topics)
        : HttpResponse.json(discussions),
    ),
    http.get(`${baseUrl}/api/v1/courses/:id/quizzes`, () =>
      forbidden.quizzes !== undefined ? denied(forbidden.quizzes) : HttpResponse.json(quizzes),
    ),
    http.get(`${baseUrl}/api/v1/announcements`, () =>
      forbidden.announcements !== undefined
        ? denied(forbidden.announcements)
        : HttpResponse.json(announcements),
    ),
    http.get(`${baseUrl}/api/v1/calendar_events`, () =>
      forbidden.calendar_events !== undefined
        ? denied(forbidden.calendar_events)
        : HttpResponse.json(calendarEvents),
    ),
  )
}
