import { describe, expect, it } from "vitest"

import { expandConfirmedMeetings } from "../../src/engines/meeting-recurrence.js"
import { weekBounds } from "../../src/engines/retrieve-selection.js"

const rules = [
  {
    courseCanvasId: "101",
    daysOfWeek: [1, 3],
    localTime: "10:00",
    startsOn: "2026-10-26",
    endsOn: "2026-11-04",
  },
]

describe("confirmed meeting recurrence", () => {
  it("expands local weekdays across a DST transition without shifting class time", () => {
    const result = expandConfirmedMeetings(rules, "America/Los_Angeles", "2026-10-26", "2026-11-04")
    expect(result.map((meeting) => meeting.startsAt)).toEqual([
      "2026-10-26T17:00:00.000Z",
      "2026-10-28T17:00:00.000Z",
      "2026-11-02T18:00:00.000Z",
      "2026-11-04T18:00:00.000Z",
    ])
  })

  it("does not emit meetings outside the confirmed term or requested window", () => {
    expect(expandConfirmedMeetings(rules, "UTC", "2026-11-05", "2026-11-10")).toEqual([])
  })

  it("uses local week boundaries for source selection across DST", () => {
    const bounds = weekBounds("2026-10-26", "America/Los_Angeles")
    expect(bounds?.map((value) => new Date(value).toISOString())).toEqual([
      "2026-10-26T07:00:00.000Z",
      "2026-11-02T08:00:00.000Z",
    ])
    expect(Date.parse("2026-11-02T07:00:00Z")).toBeGreaterThanOrEqual(bounds?.[0] ?? Infinity)
    expect(Date.parse("2026-11-02T07:00:00Z")).toBeLessThan(bounds?.[1] ?? -Infinity)
  })
})
