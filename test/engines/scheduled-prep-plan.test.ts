import { describe, expect, it } from "vitest"

import {
  planScheduledPrep,
  type ScheduledPrepMeeting,
} from "../../src/engines/scheduled-prep-plan.js"

const meeting = (
  courseCanvasId: string,
  startsAt: string,
  source = "calendar",
): ScheduledPrepMeeting => ({ courseCanvasId, startsAt, source })

describe("planScheduledPrep", () => {
  it("selects only enrolled courses and the earliest active meeting per local week", () => {
    const later = meeting("101", "2026-09-30T09:00:00-07:00")
    const earliest = meeting("101", "2026-09-29T09:00:00-07:00")
    const plan = planScheduledPrep({
      meetings: [
        later,
        meeting("102", "2026-09-29T09:00:00-07:00"),
        meeting("103", "2026-09-29T09:00:00-07:00"),
        meeting("104", "2026-09-29T09:00:00-07:00"),
        meeting("105", "2026-09-29T09:00:00-07:00"),
        earliest,
      ],
      enrollmentByCourseId: {
        "101": "enrolled",
        "102": "waitlisted",
        "103": "old",
        "104": "unknown",
      },
      now: "2026-09-28T12:00:00-07:00",
      timeZone: "America/Los_Angeles",
      leadHours: 24,
      windowHours: 24,
    })
    expect(plan.jobs).toEqual([
      {
        courseCanvasId: "101",
        startsAt: "2026-09-29T16:00:00.000Z",
        dueAt: "2026-09-28T16:00:00.000Z",
        weekStart: "2026-09-28",
        idempotencyKey: "prep:101:2026-09-28",
        source: "calendar",
      },
    ])
    expect(plan.skipped.map((skip) => skip.reason).sort()).toEqual([
      "duplicate-week",
      "not-enrolled",
      "not-enrolled",
      "not-enrolled",
      "not-enrolled",
    ])
  })

  it("uses the configured local week across the spring daylight-saving transition", () => {
    const input = {
      meetings: [meeting("101", "2027-03-15T00:30:00-07:00")],
      enrollmentByCourseId: { "101": "enrolled" as const },
      timeZone: "America/Los_Angeles",
      leadHours: 24,
      windowHours: 24,
    }
    const active = planScheduledPrep({ ...input, now: "2027-03-14T00:30:00-08:00" })
    expect(active.jobs[0]).toMatchObject({
      weekStart: "2027-03-15",
      dueAt: "2027-03-14T07:30:00.000Z",
    })
    expect(
      planScheduledPrep({ ...input, now: "2027-03-13T23:00:00-08:00" }).skipped[0]?.reason,
    ).toBe("not-due")
    expect(
      planScheduledPrep({ ...input, now: "2027-03-15T00:30:01-07:00" }).skipped[0]?.reason,
    ).toBe("expired")
  })

  it("rejects future and expired windows and suppresses completed jobs", () => {
    const input = {
      meetings: [meeting("101", "2026-10-05T09:00:00-07:00")],
      enrollmentByCourseId: { "101": "enrolled" as const },
      timeZone: "America/Los_Angeles",
      leadHours: 24,
      windowHours: 24,
    }
    expect(
      planScheduledPrep({ ...input, now: "2026-10-04T08:59:59-07:00" }).skipped[0]?.reason,
    ).toBe("not-due")
    expect(
      planScheduledPrep({ ...input, now: "2026-10-05T09:00:01-07:00" }).skipped[0]?.reason,
    ).toBe("expired")
    expect(
      planScheduledPrep({
        ...input,
        now: "2026-10-04T09:00:00-07:00",
        completedKeys: new Set(["prep:101:2026-10-05"]),
      }).skipped[0]?.reason,
    ).toBe("already-completed")
  })

  it("fails closed for canceled and invalid meetings without blocking valid jobs", () => {
    const invalid = meeting("101", "2026-11-01T09:00:00")
    const rolledOver = meeting("101", "2026-02-30T09:00:00-08:00")
    const canceled = { ...meeting("101", "2026-11-02T09:00:00-08:00"), canceled: true }
    const valid = meeting("101", "2026-11-02T09:00:00-08:00")
    const plan = planScheduledPrep({
      meetings: [invalid, rolledOver, canceled, valid],
      enrollmentByCourseId: { "101": "enrolled" },
      now: "2026-11-01T10:00:00-08:00",
      timeZone: "America/Los_Angeles",
      leadHours: 24,
      windowHours: 24,
    })
    expect(plan.jobs).toHaveLength(1)
    expect(plan.jobs[0]?.weekStart).toBe("2026-11-02")
    expect(plan.skipped.map((skip) => skip.reason).sort()).toEqual([
      "canceled",
      "invalid-meeting",
      "invalid-meeting",
    ])
  })
})
