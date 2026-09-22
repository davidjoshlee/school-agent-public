import { describe, expect, it } from "vitest"

import { listCourses } from "../../src/canvas/endpoints.js"

import { installCourseHandlers } from "./canvasMock.js"
import { client } from "./schoolConfig.js"

describe("test/helpers/canvasMock", () => {
  it("serves the canonical course list from the shared mock", async () => {
    // Given: the shared deterministic Canvas handler baseline.
    installCourseHandlers()

    // When: a typed read endpoint addresses the shared mock.
    const courses = await listCourses(client(), "completed")

    // Then: the canonical course is returned with its real identity.
    expect(courses[0]).toMatchObject({ id: "1", name: "Pricing", course_code: "FIN-101" })
  })
})
