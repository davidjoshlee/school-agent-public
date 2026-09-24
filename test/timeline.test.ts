import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  buildTimeline,
  crossCheckIcs,
  renderTimeline,
  writeDueSoonReminders,
} from "../src/engines/timeline.js"
import { createSchoolIndex } from "../src/store/db.js"
import { VaultWriter } from "../src/store/vault.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

function populatedIndex() {
  const index = createSchoolIndex({ path: ":memory:" })
  index.upsertCourse({
    canvasId: "1",
    name: "Finance",
    courseCode: "FIN-101",
    workflowState: "available",
    vaultPath: "course-1",
  })
  index.upsertCourse({
    canvasId: "2",
    name: "Leadership",
    courseCode: "LEAD-202",
    workflowState: "available",
    vaultPath: "course-2",
  })
  index.upsertAssignment({
    canvasId: "assignment-base",
    courseCanvasId: "1",
    name: "Case memo",
    dueAt: "2026-10-08T17:00:00Z",
    vaultPath: "course-1/Assignments/2026-10-08 - Case memo/00 Prompt.md",
    allDates: [],
  })
  index.upsertAssignment({
    canvasId: "assignment-override",
    courseCanvasId: "2",
    name: "Reflection",
    dueAt: "2026-10-09T17:00:00Z",
    vaultPath: "course-2/Assignments/2026-10-09 - Reflection/00 Prompt.md",
    allDates: [
      {
        canvasId: "assignment-override:override",
        dueAt: "2026-10-07T17:00:00Z",
        isUserOverride: true,
      },
    ],
  })
  index.upsertAssignment({
    canvasId: "assignment-undated",
    courseCanvasId: "1",
    name: "Optional reading",
    dueAt: null,
    vaultPath: "course-1/Assignments/Undated - Optional reading/00 Prompt.md",
    allDates: [],
  })
  index.upsertAnnouncement({
    canvasId: "announcement-1",
    courseCanvasId: "1",
    title: "Bring your spreadsheet",
    postedAt: "2026-10-06T12:00:00Z",
    vaultPath: "course-1/Other/Announcements/Bring your spreadsheet.md",
  })
  return index
}

describe("timeline engine", () => {
  it("orders multiple courses by effective due date and flags announcements for action", () => {
    // Given: assignments across courses with a personal due-date override and an announcement.
    const index = populatedIndex()

    // When: the next two weeks are assembled into a timeline.
    const timeline = buildTimeline({ index, weeks: 2, now: new Date("2026-10-05T00:00:00Z") })

    // Then: override-aware dated work is chronological, announcements are actionable, and undated work stays separate.
    expect(timeline.dated.map((day) => day.items.map((item) => item.title))).toEqual([
      ["Bring your spreadsheet"],
      ["Reflection"],
      ["Case memo"],
    ])
    expect(timeline.dated[0]?.items[0]).toMatchObject({
      kind: "announcement",
      actionRequired: true,
    })
    expect(timeline.undated.map((item) => item.title)).toEqual(["Optional reading"])
    index.close()
  })

  it("writes a due-soon alert and calls the injected macOS notifier", async () => {
    // Given: a due item inside the configured reminder window and an isolated vault.
    const index = populatedIndex()
    const vaultRoot = await temporaryDirectory("school-agent-timeline-")
    const notify = vi.fn<(title: string, message: string) => Promise<void>>().mockResolvedValue()

    // When: due-soon reminders are delivered.
    await writeDueSoonReminders({
      index,
      leadDays: 3,
      now: new Date("2026-10-05T00:00:00Z"),
      vault: new VaultWriter({ root: vaultRoot, gitInit: false }),
      canvasUrl: "https://canvas.test",
      notify,
    })

    // Then: the durable alert channel and the injectable desktop channel describe the effective due item.
    await expect(readFile(join(vaultRoot, "_meta", "ALERT.md"), "utf8")).resolves.toContain(
      "Reflection",
    )
    expect(notify).toHaveBeenCalledWith(
      "School agent: due soon",
      expect.stringContaining("Reflection"),
    )
    index.close()
  })

  it("flags Canvas ICS events that disagree with indexed effective due dates", () => {
    // Given: an indexed assignment and a free ICS event bearing a different due time.
    const index = populatedIndex()

    // When: the read-only ICS feed is cross-checked.
    const mismatches = crossCheckIcs({
      index,
      ics: [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:Case memo",
        "DTSTART:20261009T170000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    })

    // Then: the discrepancy is surfaced without exporting or modifying calendar data.
    expect(mismatches).toEqual([
      {
        title: "Case memo",
        courseCode: "FIN-101",
        indexDueAt: "2026-10-08T17:00:00Z",
        icsDueAt: "2026-10-09T17:00:00Z",
      },
    ])
    index.close()
  })

  it("renders a friendly empty state when no dated items exist", () => {
    // Given: a course with only an undated assignment.
    const index = createSchoolIndex({ path: ":memory:" })
    index.upsertCourse({
      canvasId: "course-1",
      name: "Strategy",
      courseCode: "STRAT-1",
      workflowState: "available",
      vaultPath: "strat-1",
    })
    index.upsertAssignment({
      canvasId: "assignment-undated",
      courseCanvasId: "course-1",
      name: "Choose a topic",
      dueAt: null,
      vaultPath: "strat-1/assignments/topic.md",
      allDates: [],
    })

    // When: the timeline is rendered.
    const output = renderTimeline(
      buildTimeline({ index, weeks: 2, now: new Date("2026-10-05T00:00:00Z") }),
    )

    // Then: the command stays useful without inventing a due date.
    expect(output).toContain("No dated items in this timeline.")
    expect(output).toContain("Undated")
    expect(output).toContain("Choose a topic")
    index.close()
  })
})
