import { describe, expect, it } from "vitest"

import { displayCourseCode } from "../src/canvas/course-identity.js"
import { courseDirectoryName, coursePaths } from "../src/store/paths.js"

describe("human-facing course directory names", () => {
  it.each([
    ["F26-DEMO-101-01/02", 1001, "DEMO101"],
    ["F26-EXAMPLE-203T-01", 1002, "EXAMPLE203T"],
    ["26Su-PRACTICE", 1003, "PRACTICE"],
  ])("uses the course name for %s", (code, id, expected) => {
    expect(courseDirectoryName(code, id)).toBe(expected)
    expect(coursePaths("/vault", code, id).root).toBe(`/vault/${expected}`)
  })

  it("retains the safe fallback for unrecognized codes", () => {
    expect(courseDirectoryName("FIN 101", 1)).toBe("fin-101")
    expect(courseDirectoryName("", 1)).toBe("untitled-1")
  })

  it("uses the Canvas name when course_code is absent", () => {
    const course = { id: 1004, name: "F26-DEMO-104-01 - Example", course_code: null }
    expect(displayCourseCode(course)).toBe(course.name)
    expect(courseDirectoryName(displayCourseCode(course), course.id)).toBe("DEMO104")
  })
})
