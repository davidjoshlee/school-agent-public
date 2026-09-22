import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"

import {
  AssignmentSchema,
  CANVAS_READ_ROUTES,
  CourseSchema,
  getFile,
  getModulePage,
  getOwnSubmission,
  getQuiz,
  getSyllabus,
  listAnnouncements,
  listAssignments,
  listCalendarEvents,
  listCourses,
  listDiscussionTopics,
  listFiles,
  listModules,
  listPlannerItems,
  listQuizzes,
  OwnSubmissionSchema,
} from "../src/canvas/endpoints.js"
import { server } from "./helpers/canvasMock.js"
import { client } from "./helpers/schoolConfig.js"

function responseBody(pathname: string): unknown {
  switch (pathname) {
    case "/api/v1/courses":
      return [{ id: "course-1", name: "Concluded course", concluded: true }]
    case "/api/v1/courses/course-1/modules":
      return [{ id: "module-1", name: "Week one", items: [] }]
    case "/api/v1/courses/course-1/assignments":
      return [{ id: "assignment-1", name: "Reflection", due_at: null, has_overrides: true }]
    case "/api/v1/announcements":
      return [{ id: "announcement-1", title: "Welcome" }]
    case "/api/v1/courses/course-1":
      return { id: "course-1", name: "Syllabus", syllabus_body: "<p>Read this</p>" }
    case "/api/v1/courses/course-1/pages/week-one":
      return { page_id: "page-1", url: "week-one", title: "Week one", body: "<p>Page</p>" }
    case "/api/v1/courses/course-1/files":
      return [{ id: "file-1", display_name: "outline.pdf" }]
    case "/api/v1/planner/items":
      return [{ plannable_id: "assignment-1", plannable_type: "assignment" }]
    case "/api/v1/calendar_events":
      return [{ id: "event-1", title: "Class" }]
    case "/api/v1/courses/course-1/discussion_topics":
      return [{ id: "topic-1", title: "Prompt", message: "Discuss" }]
    case "/api/v1/courses/course-1/quizzes":
      return [{ id: "quiz-1", title: "Quiz" }]
    case "/api/v1/courses/course-1/quizzes/quiz-1":
      return { id: "quiz-1", title: "Quiz" }
    case "/api/v1/courses/course-1/assignments/assignment-1/submissions/self":
      return {
        id: "submission-1",
        assignment_id: "assignment-1",
        rubric_assessment: { criterion_1: { points: 5 } },
        submission_comments: [{ comment: "Strong work" }],
      }
    default:
      return { id: "unreachable" }
  }
}

describe("Canvas typed read endpoints", () => {
  it("uses only GET routes and excludes peer-content routes", () => {
    // Given: the endpoint route table.

    // When: each documented read route is inspected.

    // Then: no mutation or peer-content endpoint is available to this module.
    expect(CANVAS_READ_ROUTES.every((route) => route.method === "GET")).toBe(true)
    expect(
      CANVAS_READ_ROUTES.some((route) =>
        /discussion_topics\/:topicId\/entries/.test(route.endpoint),
      ),
    ).toBe(false)
    expect(
      CANVAS_READ_ROUTES.some(
        (route) =>
          route.endpoint.includes("/submissions") && !route.endpoint.endsWith("/submissions/self"),
      ),
    ).toBe(false)
  })

  it("fetches every allowed read resource with its required Canvas include parameters", async () => {
    // Given: MSW responses for every allowed Canvas route.
    const requested: URL[] = []
    server.use(
      http.get("https://canvas.test/api/v1/*", ({ request }) => {
        const url = new URL(request.url)
        requested.push(url)
        return HttpResponse.json(responseBody(url.pathname))
      }),
    )

    // When: every typed helper reads its permitted resource.
    await listCourses(client(), "completed")
    await listModules(client(), "course-1")
    await listAssignments(client(), "course-1")
    await listAnnouncements(client(), "course-1")
    await getSyllabus(client(), "course-1")
    await getModulePage(client(), "course-1", "week-one")
    await listFiles(client(), "course-1")
    await listPlannerItems(client(), "course-1")
    await listCalendarEvents(client(), "course-1")
    await listDiscussionTopics(client(), "course-1")
    await listQuizzes(client(), "course-1")
    await getQuiz(client(), "course-1", "quiz-1")
    await getOwnSubmission(client(), "course-1", "assignment-1")

    // Then: each documented include is present and requests remain in the GET-only MSW boundary.
    const byPath = (pathname: string): URL => {
      const found = requested.find((url) => url.pathname === pathname)
      if (found === undefined) {
        throw new Error(`Missing request: ${pathname}`)
      }
      return found
    }
    expect(byPath("/api/v1/courses").searchParams.get("enrollment_state")).toBe("completed")
    expect(byPath("/api/v1/courses").searchParams.getAll("include[]")).toEqual([
      "term",
      "calendar",
      "concluded",
    ])
    expect(byPath("/api/v1/courses").searchParams.getAll("state[]")).toEqual(["completed"])
    expect(byPath("/api/v1/courses/course-1/modules").searchParams.getAll("include[]")).toEqual([
      "items",
      "content_details",
    ])
    expect(byPath("/api/v1/courses/course-1/assignments").searchParams.getAll("include[]")).toEqual(
      ["all_dates", "rubric", "submission"],
    )
    expect(byPath("/api/v1/courses/course-1").searchParams.getAll("include[]")).toEqual([
      "syllabus_body",
    ])
    expect(
      byPath("/api/v1/courses/course-1/pages/week-one").searchParams.getAll("include[]"),
    ).toEqual(["body"])
    expect(
      byPath(
        "/api/v1/courses/course-1/assignments/assignment-1/submissions/self",
      ).searchParams.getAll("include[]"),
    ).toEqual(["submission_history", "rubric_assessment", "submission_comments", "attachments"])
  })

  it("normalizes Canvas's hyphenated file content-type onto the canonical content_type key", async () => {
    // Given: the per-file endpoint returns `content-type` (hyphen), not `content_type`.
    server.use(
      http.get("https://canvas.test/api/v1/courses/course-1/files/file-1", () =>
        HttpResponse.json({
          id: "file-1",
          display_name: "outline.pdf",
          "content-type": "application/pdf",
          size: 123,
          updated_at: "2026-08-25T00:00:00.000Z",
        }),
      ),
    )

    // When: the typed boundary reads the individual file record.
    const file = await getFile(client(), "course-1", "file-1")

    // Then: metadata carries the canonical key so downstream extraction is not starved of the MIME type.
    expect(file.content_type).toBe("application/pdf")
  })

  it("parses concluded courses and nullable assignment edge cases without dropping unknown Canvas fields", () => {
    // Given: Canvas's concluded-course and assignment edge-case response shapes.
    const concluded = {
      id: "course-1",
      name: "Past course",
      concluded: true,
      added_by_canvas: "future",
    }
    const assignment = {
      id: "assignment-1",
      name: "Flexible due date",
      due_at: null,
      has_overrides: true,
      unknown_canvas_field: { preserved: true },
    }

    // When: the typed API boundary parses each response.
    const parsedCourse = CourseSchema.parse(concluded)
    const parsedAssignment = AssignmentSchema.parse(assignment)

    // Then: required edge cases parse and unknown data survives passthrough.
    expect(parsedCourse.concluded).toBe(true)
    expect(parsedAssignment.due_at).toBeNull()
    expect(parsedAssignment.has_overrides).toBe(true)
    expect(parsedAssignment.unknown_canvas_field).toEqual({ preserved: true })
  })

  it("parses own graded submissions including rubric feedback and instructor comments", () => {
    // Given: the own-submission response including instructor grading feedback.
    const submission = {
      id: "submission-1",
      assignment_id: "assignment-1",
      rubric_assessment: { criterion_1: { points: 5, comments: "Specific feedback" } },
      submission_comments: [{ author_id: "instructor-1", comment: "Nice analysis" }],
      submission_history: [{ submission_type: "online_text_entry" }],
      attachments: [{ id: "file-1", display_name: "reflection.pdf" }],
    }

    // When: the self-only submission schema parses the response.
    const parsed = OwnSubmissionSchema.parse(submission)

    // Then: rubric assessments and instructor comments remain available to the caller.
    expect(parsed.rubric_assessment).toEqual(submission.rubric_assessment)
    expect(parsed.submission_comments).toEqual(submission.submission_comments)
  })
})
