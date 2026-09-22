import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"
import { z } from "zod"

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
  QuizSchema,
} from "../src/canvas/endpoints.js"

const FixtureSchema = z
  .object({
    url: z.string().url(),
    status: z.number().int(),
    headers: z.record(z.string(), z.string()),
    body: z.unknown(),
  })
  .passthrough()

async function fixture(name: string): Promise<z.infer<typeof FixtureSchema>> {
  const root = fileURLToPath(new URL("./fixtures/canvas/", import.meta.url))
  const source = await readFile(join(root, name), "utf8")
  return FixtureSchema.parse(JSON.parse(source))
}

const GenericCanvasObjectSchema = z.object({ id: z.union([z.string(), z.number()]) }).passthrough()

function parseEndpointFixture(fixture_: z.infer<typeof FixtureSchema>): void {
  const path = new URL(fixture_.url).pathname
  if (path === "/api/v1/courses") {
    z.array(CourseSchema).parse(fixture_.body)
    return
  }
  if (path.endsWith("/modules")) {
    z.array(ModuleSchema).parse(fixture_.body)
    return
  }
  if (path.endsWith("/assignments")) {
    z.array(AssignmentSchema).parse(fixture_.body)
    return
  }
  if (path.endsWith("/submissions/self")) {
    OwnSubmissionSchema.parse(fixture_.body)
    return
  }
  if (path === "/api/v1/announcements") {
    z.array(AnnouncementSchema).parse(fixture_.body)
    return
  }
  if (path.endsWith("/files")) {
    z.array(FileSchema).parse(fixture_.body)
    return
  }
  if (path === "/api/v1/planner/items") {
    z.array(PlannerItemSchema).parse(fixture_.body)
    return
  }
  if (path === "/api/v1/calendar_events") {
    z.array(CalendarEventSchema).parse(fixture_.body)
    return
  }
  if (path.endsWith("/discussion_topics")) {
    z.array(DiscussionTopicSchema).parse(fixture_.body)
    return
  }
  if (path.includes("/pages/")) {
    PageSchema.parse(fixture_.body)
    return
  }
  if (path.endsWith("/quizzes")) {
    z.array(QuizSchema).parse(fixture_.body)
    return
  }
  if (path.includes("/quizzes/")) {
    QuizSchema.parse(fixture_.body)
    return
  }
  if (path === "/api/v1/users/self") {
    GenericCanvasObjectSchema.parse(fixture_.body)
    return
  }
  CourseSchema.parse(fixture_.body)
}

describe("Canvas endpoint fixtures", () => {
  it("parses every pre-M0 documentation fixture through its endpoint schema", async () => {
    // Given: redacted Canvas documentation fixtures for each uncovered response category.
    const concluded = await fixture("doc-concluded-courses.json")
    const assignment = await fixture("doc-assignment-edge-cases.json")
    const page = await fixture("doc-module-page.json")
    const submission = await fixture("doc-own-submission-feedback.json")

    // When: each endpoint body crosses its typed Zod boundary.
    const courses = z.array(CourseSchema).parse(concluded.body)
    const assignments = z.array(AssignmentSchema).parse(assignment.body)
    const parsedPage = PageSchema.parse(page.body)
    const parsedSubmission = OwnSubmissionSchema.parse(submission.body)

    // Then: concluded courses, failure shapes, module pages, and own feedback survive parsing.
    expect(courses[0]?.concluded).toBe(true)
    expect(assignments[0]?.due_at).toBeNull()
    expect(assignments[0]?.canvas_future_field).toEqual({ preserved: true })
    expect(parsedPage.body).toBe("<p>Module-referenced page</p>")
    expect(parsedSubmission.rubric_assessment).toBeDefined()
  })

  it("parses every committed synthetic fixture through its matching Zod boundary", async () => {
    // Given: synthetic Canvas responses, with no live course text or identities.
    const directory = new URL("./fixtures/canvas/", import.meta.url)
    const names = await readdir(fileURLToPath(directory))
    const fixtures = await Promise.all(names.map(fixture))

    // When: the fixture body is routed through its matching typed schema.
    for (const fixture_ of fixtures) {
      parseEndpointFixture(fixture_)
    }

    // Then: all fixtures are valid at the typed boundary.
    expect(fixtures.length).toBeGreaterThan(0)
  })
})
