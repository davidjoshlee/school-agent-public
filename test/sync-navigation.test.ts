import { describe, expect, it } from "vitest"

import {
  buildNavigationModel,
  classifyNavigationItem,
  navigationArtifacts,
  renderHome,
  renderPeriodOverview,
} from "../src/canvas/sync-navigation.js"

describe("sync navigation", () => {
  it("uses explicit and high-confidence categories while conservatively retaining Other", () => {
    expect(
      classifyNavigationItem({ title: "Pre-class reading", path: "Week 01/reading.pdf" }),
    ).toBe("prep")
    expect(
      classifyNavigationItem({ title: "Lecture slides", path: "Week 01/slide-deck.pdf" }),
    ).toBe("materials")
    expect(
      classifyNavigationItem({
        title: "Session 1",
        path: "Week 01/session-1.md",
        type: "modules",
      }),
    ).toBe("other")
    expect(
      classifyNavigationItem({
        title: "Problem set",
        path: "Assignments/problem-set.md",
        type: "assignments",
      }),
    ).toBe("other")
    expect(
      classifyNavigationItem({
        title: "Instructor packet",
        path: "Week 01/packet.md",
        category: "prep",
      }),
    ).toBe("prep")
  })

  it("groups dated module content by Monday calendar week and renders current/next navigation", () => {
    const model = buildNavigationModel({
      course: { name: "Financial Reporting", code: "DEMO-101" },
      now: "2026-09-23T12:00:00Z",
      documents: [
        {
          title: "Session 1",
          path: "Week 01/session-1.md",
          type: "modules",
          dates: { session_at: "2026-09-22T16:00:00Z" },
        },
        {
          title: "Pre-class reading",
          path: "Week 01/prep-reading.pdf",
          type: "files",
          dates: { session_at: "2026-09-22T16:00:00Z" },
        },
        {
          title: "Lecture slides",
          path: "Week 02/lecture-slides.pdf",
          type: "files",
          dates: { session_at: "2026-09-29T16:00:00Z" },
        },
        {
          title: "Unclassified note",
          path: "Week 01/note.md",
          dates: { session_at: "2026-09-22T16:00:00Z" },
        },
      ],
      assignments: [
        {
          title: "Case memo",
          path: "Assignments/case-memo.md",
          canvasId: 21,
          dueAt: "2026-09-25T23:59:00Z",
        },
      ],
    })

    expect(model.periods.map((period) => period.title)).toEqual([
      "Week 01 - Sep 21",
      "Week 02 - Sep 28",
    ])
    expect(model.currentPeriodId).toBe("week-2026-09-21")
    expect(model.nextPeriodId).toBe("week-2026-09-28")
    expect(model.periods[0]?.documents.prep.map((item) => item.title)).toEqual([
      "Pre-class reading",
    ])
    expect(model.periods[0]?.documents.materials).toEqual([])
    expect(model.periods[0]?.documents.other.map((item) => item.title)).toEqual([
      "Session 1",
      "Unclassified note",
    ])
    expect(model.periods[0]?.assignments.map((item) => item.title)).toEqual(["Case memo"])

    const home = renderHome(model)
    expect(home).toContain("**Current:** [Week 01 - Sep 21](Week 01 - Sep 21/00 Overview.md)")
    expect(home).toContain("**Next:** [Week 02 - Sep 28](Week 02 - Sep 28/00 Overview.md)")
    expect(home).toContain("[Case memo](Assignments/case-memo.md) — Sep 25")

    const overview = renderPeriodOverview(model, "week-2026-09-21")
    expect(overview).toContain("## Prep")
    expect(overview).toContain("[Pre-class reading](../Week 01/prep-reading.pdf)")
    expect(overview).toContain("## Other")
    expect(overview).toContain("[Unclassified note](../Week 01/note.md)")
    expect(overview).toContain("[Case memo](../Assignments/case-memo.md) — Sep 25")
  })

  it("surfaces a clear unpublished message when Canvas has no dated weekly content", () => {
    const model = buildNavigationModel({
      course: { name: "Strategy", code: "DEMO-516" },
      documents: [
        {
          title: "Syllabus",
          path: "Resources/Syllabus.md",
          type: "00-syllabus.md",
        },
      ],
      assignments: [
        {
          title: "Qualification form",
          path: "Assignments/qualification-form.md",
          dueAt: null,
        },
      ],
    })

    expect(model.periods).toEqual([])
    expect(model.weeklyContentPublished).toBe(false)
    expect(model.weeklyContentMessage).toContain("has not been published in Canvas yet")
    expect(renderHome(model)).toContain("> Weekly content has not been published in Canvas yet.")
  })

  it("groups non-week material by explicit milestones and emits one home plus one overview per period", () => {
    const model = buildNavigationModel({
      course: { name: "Milestone Workshop", code: "DEMO-200" },
      periodKind: "milestone",
      now: "2026-10-02T12:00:00Z",
      milestones: [
        { id: "goals", title: "Goal setting", startAt: "2026-09-20", endAt: "2026-10-04" },
        {
          id: "reflection",
          title: "Final reflection",
          startAt: "2026-10-05",
          endAt: "2026-10-20",
        },
      ],
      documents: [
        {
          title: "Goal setting form",
          path: "Milestones/Goal setting/prep-form.md",
          type: "files",
          dates: { created_at: "2026-09-22" },
        },
        {
          title: "Reflection prompt",
          path: "Milestones/Final reflection/prompt.md",
          type: "files",
          dates: { created_at: "2026-10-08" },
        },
      ],
    })

    expect(model.periods.map((period) => period.title)).toEqual([
      "Milestone 01 - Goal setting",
      "Milestone 02 - Final reflection",
    ])
    expect(model.currentPeriodId).toBe("milestone-goals")
    expect(model.nextPeriodId).toBe("milestone-reflection")
    expect(navigationArtifacts(model).map((artifact) => artifact.path)).toEqual([
      "00 Home.md",
      "Milestone 01 - Goal setting/00 Overview.md",
      "Milestone 02 - Final reflection/00 Overview.md",
    ])
  })
})
