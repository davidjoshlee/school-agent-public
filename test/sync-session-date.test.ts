import { describe, expect, it } from "vitest"

import { parseSessionDate, resolveCourseYear } from "../src/canvas/sync-session-date.js"

describe("parseSessionDate", () => {
  it("parses a full month-name date out of a session title", () => {
    expect(parseSessionDate("Session 8 (October 16)", 2025)).toBe("2025-10-16")
  })

  it("parses an abbreviated month name", () => {
    expect(parseSessionDate("Session 8 - Oct 16", 2025)).toBe("2025-10-16")
  })

  it("parses a slash-form date", () => {
    expect(parseSessionDate("Session 8 (10/16)", 2025)).toBe("2025-10-16")
  })

  it("returns undefined when courseYear cannot be resolved", () => {
    expect(parseSessionDate("Session 8 (October 16)", undefined)).toBeUndefined()
  })

  it("returns undefined when the title carries no date", () => {
    expect(parseSessionDate("Session 8: ExampleCo", 2025)).toBeUndefined()
  })

  it("returns undefined when two candidate dates in the title disagree", () => {
    expect(parseSessionDate("Session 8 (October 16, moved from Oct 17)", 2025)).toBeUndefined()
  })

  it("agrees when the same date is spelled two ways in the title", () => {
    expect(parseSessionDate("Session 8 (October 16 / 10/16)", 2025)).toBe("2025-10-16")
  })
})

describe("resolveCourseYear", () => {
  it("prefers the course term start_at", () => {
    expect(
      resolveCourseYear({ term: { start_at: "2025-09-20T00:00:00Z" } }, ["2026-01-05T00:00:00Z"]),
    ).toBe(2025)
  })

  it("falls back to the course's own start_at when there is no term", () => {
    expect(resolveCourseYear({ start_at: "2025-09-20T00:00:00Z" }, [])).toBe(2025)
  })

  it("falls back to the strict-majority year among assignment due_ats", () => {
    expect(
      resolveCourseYear({}, [
        "2025-10-01T00:00:00Z",
        "2025-11-01T00:00:00Z",
        "2026-01-05T00:00:00Z",
      ]),
    ).toBe(2025)
  })

  it("leaves the year unresolved on a tie", () => {
    expect(resolveCourseYear({}, ["2025-10-01T00:00:00Z", "2026-01-05T00:00:00Z"])).toBeUndefined()
  })

  it("leaves the year unresolved when there is no date data at all", () => {
    expect(resolveCourseYear({}, [null, undefined])).toBeUndefined()
  })
})
