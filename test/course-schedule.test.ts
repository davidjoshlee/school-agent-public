import { describe, expect, it } from "vitest"

import { classifyCourseStanding, discoverCourseSchedule } from "../src/canvas/course-schedule.js"
import { CanvasHttpError } from "../src/canvas/http.js"

function client(pages: Record<string, unknown[]>) {
  return {
    async *paginate(path: string) {
      const key = path.startsWith("/api/v1/calendar_events")
        ? `calendar:${new URL(path, "https://canvas.example").searchParams.get("context_codes[]")}`
        : "enrollments"
      yield new Response(JSON.stringify(pages[key] ?? []), {
        headers: { "content-type": "application/json" },
      })
    },
  }
}

describe("course standing and schedule discovery", () => {
  it("fails closed on conflicting, invited, and missing enrollment evidence", () => {
    const rows = [
      { course_id: 1, enrollment_state: "active", type: "StudentEnrollment" },
      { course_id: 1, enrollment_state: "waitlisted", type: "StudentEnrollment" },
      { course_id: 2, enrollment_state: "invited", type: "StudentEnrollment" },
      { course_id: 3, enrollment_state: "completed", type: "StudentEnrollment" },
    ]
    expect(classifyCourseStanding("1", rows).standing).toBe("unknown")
    expect(classifyCourseStanding("2", rows).standing).toBe("unknown")
    expect(classifyCourseStanding("3", rows).standing).toBe("old")
    expect(classifyCourseStanding("4", rows).standing).toBe("unknown")
    expect(classifyCourseStanding("1", rows, "waitlisted").standing).toBe("waitlisted")
  })

  it("returns only dated event candidates for enrolled courses and exposes coverage", async () => {
    const fixture = {
      enrollments: [
        { course_id: 1, enrollment_state: "active", type: "StudentEnrollment" },
        { course_id: 2, enrollment_state: "completed", type: "StudentEnrollment" },
      ],
      "calendar:course_1": [
        {
          id: 7,
          title: "Seminar",
          context_code: "course_1",
          start_at: "2026-09-28T10:00:00-07:00",
          end_at: "2026-09-28T11:30:00-07:00",
        },
        {
          id: 8,
          title: "Holiday",
          context_code: "course_1",
          start_at: "2026-09-29T10:00:00-07:00",
          end_at: "2026-09-29T11:30:00-07:00",
          blackout_date: true,
        },
        {
          id: 9,
          title: "Wrong course",
          context_code: "course_2",
          start_at: "2026-09-29T10:00:00-07:00",
          end_at: "2026-09-29T11:30:00-07:00",
        },
      ],
    }
    const result = await discoverCourseSchedule(client(fixture), {
      courseIds: ["1", "2"],
      startDate: "2026-09-28",
      endDate: "2026-09-30",
    })
    expect(result.courses.map(({ standing }) => standing)).toEqual(["enrolled", "old"])
    expect(result.events).toEqual([
      {
        id: "7",
        courseId: "1",
        title: "Seminar",
        startAt: "2026-09-28T10:00:00-07:00",
        endAt: "2026-09-28T11:30:00-07:00",
      },
    ])
    expect(result.coverage).toBe("canvas-calendar-only")
    expect(result.enrollmentCoverage).toBe("available")
    expect(result.calendarCoverage).toEqual({ "1": "queried", "2": "not-queried" })
    expect(result.skippedCalendarEvents).toBe(2)
  })

  it("keeps enrollment and calendar permission gaps visible", async () => {
    const deniedEnrollment = {
      async *paginate() {
        yield await Promise.reject(new CanvasHttpError(403))
      },
    }
    const unknown = await discoverCourseSchedule(deniedEnrollment, {
      courseIds: ["1"],
      startDate: "2026-09-28",
      endDate: "2026-09-30",
    })
    expect(unknown.courses[0]?.standing).toBe("unknown")
    expect(unknown.enrollmentCoverage).toBe("permission-denied")

    const deniedCalendar = {
      async *paginate(path: string) {
        if (path.startsWith("/api/v1/calendar_events")) throw new CanvasHttpError(403)
        yield new Response(JSON.stringify([{ course_id: 1, enrollment_state: "active" }]))
      },
    }
    const unavailable = await discoverCourseSchedule(deniedCalendar, {
      courseIds: ["1"],
      startDate: "2026-09-28",
      endDate: "2026-09-30",
    })
    expect(unavailable.events).toEqual([])
    expect(unavailable.calendarCoverage).toEqual({ "1": "permission-denied" })
  })
})
