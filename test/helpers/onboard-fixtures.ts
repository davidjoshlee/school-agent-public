import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { HttpResponse, http } from "msw"

import { server } from "./canvasMock.js"
import { temporaryDirectory } from "./tempDir.js"

/**
 * Write a minimal `school.config.json` for the onboard tests and return the
 * three paths the assertions depend on (config, vault, index).
 */
export async function createConfiguration(): Promise<{
  readonly configurationPath: string
  readonly vaultPath: string
  readonly indexPath: string
}> {
  const directory = await temporaryDirectory("school-agent-onboard-")
  const vaultPath = join(directory, "vault")
  const indexPath = join(directory, "index.db")
  const configurationPath = join(directory, "school.config.json")
  await writeFile(
    configurationPath,
    JSON.stringify({
      canvas: { baseUrl: "https://canvas.test" },
      vault: { path: vaultPath, gitInit: false },
      index: { path: indexPath },
    }),
    "utf8",
  )
  return { configurationPath, vaultPath, indexPath }
}

export function installPilotHandlers(syllabus: string, assignments = true): void {
  server.use(
    http.get("https://canvas.test/api/v1/courses", ({ request }) => {
      const state = new URL(request.url).searchParams.get("enrollment_state")
      return HttpResponse.json(
        state === "completed"
          ? [
              {
                id: "10",
                name: "Concluded Strategy",
                course_code: "STRAT-10",
                concluded: true,
              },
            ]
          : [{ id: "20", name: "Current Finance", course_code: "FIN-20" }],
      )
    }),
    http.get("https://canvas.test/api/v1/courses/10/modules", () => HttpResponse.json([])),
    http.get("https://canvas.test/api/v1/courses/10/assignments", () =>
      HttpResponse.json(
        assignments
          ? [
              {
                id: "21",
                name: "Case memo",
                description: "Apply the framework.",
                all_dates: [],
              },
            ]
          : [],
      ),
    ),
    http.get("https://canvas.test/api/v1/announcements", () => HttpResponse.json([])),
    http.get("https://canvas.test/api/v1/calendar_events", () => HttpResponse.json([])),
    http.get("https://canvas.test/api/v1/courses/10", () =>
      HttpResponse.json({
        id: "10",
        name: "Concluded Strategy",
        course_code: "STRAT-10",
        concluded: true,
        syllabus_body: syllabus,
      }),
    ),
    http.get("https://canvas.test/api/v1/courses/10/files", () => HttpResponse.json([])),
    http.get("https://canvas.test/api/v1/courses/10/discussion_topics", () =>
      HttpResponse.json([]),
    ),
    http.get("https://canvas.test/api/v1/courses/10/quizzes", () => HttpResponse.json([])),
    http.get("https://canvas.test/api/v1/courses/10/assignments/21/submissions/self", () =>
      HttpResponse.json({
        id: "31",
        assignment_id: "21",
        workflow_state: "graded",
        score: 95,
        submission_comments: [{ comment: "Lead with the evidence." }],
      }),
    ),
  )
}

export function installFallbackCourseHandlers(options: {
  readonly graded: boolean
  readonly assignmentsReadable?: boolean
}): void {
  const { graded, assignmentsReadable = true } = options
  function submissionOf(assignmentId: string, isGraded: boolean) {
    return isGraded
      ? {
          id: `4${assignmentId}`,
          assignment_id: assignmentId,
          workflow_state: "graded",
          score: 80,
        }
      : {
          id: `4${assignmentId}`,
          assignment_id: assignmentId,
          workflow_state: "unsubmitted",
          score: null,
        }
  }
  server.use(
    http.get("https://canvas.test/api/v1/courses", ({ request }) => {
      const state = new URL(request.url).searchParams.get("enrollment_state")
      return HttpResponse.json(
        state === "completed"
          ? [{ id: "10", name: "Concluded Strategy", course_code: "STRAT-10" }]
          : [{ id: "20", name: "Current Finance", course_code: "FIN-20" }],
      )
    }),
    http.get("https://canvas.test/api/v1/courses/30", () =>
      HttpResponse.json({
        id: "30",
        name: "Ended Operations",
        course_code: "OIT-30",
        workflow_state: "available",
        syllabus_body: "Operations syllabus",
      }),
    ),
    http.get("https://canvas.test/api/v1/courses/30/assignments", () =>
      assignmentsReadable
        ? HttpResponse.json([
            { id: "31", name: "Midterm", due_at: "2026-01-05T00:00:00Z" },
            { id: "32", name: "Final", due_at: "2026-01-30T00:00:00Z" },
          ])
        : new HttpResponse(null, { status: 403 }),
    ),
    http.get("https://canvas.test/api/v1/courses/30/modules", () => HttpResponse.json([])),
    http.get("https://canvas.test/api/v1/announcements", () => HttpResponse.json([])),
    http.get("https://canvas.test/api/v1/calendar_events", () => HttpResponse.json([])),
    http.get("https://canvas.test/api/v1/courses/30/files", () =>
      HttpResponse.json([], { status: 403 }),
    ),
    http.get("https://canvas.test/api/v1/courses/30/discussion_topics", () =>
      HttpResponse.json([]),
    ),
    http.get("https://canvas.test/api/v1/courses/30/quizzes", () => HttpResponse.json([])),
    http.get("https://canvas.test/api/v1/courses/30/assignments/31/submissions/self", () =>
      HttpResponse.json(submissionOf("31", graded)),
    ),
    http.get("https://canvas.test/api/v1/courses/30/assignments/32/submissions/self", () =>
      HttpResponse.json(submissionOf("32", graded)),
    ),
  )
}
