import { describe, expect, it } from "vitest"

import {
  assignmentPaths,
  courseDocumentPath,
  coursePaths,
  legacyCourseDocumentPath,
  milestonePaths,
  vaultDocumentKinds,
  vaultLayout,
  weekPaths,
} from "../src/store/paths.js"

const course = coursePaths("/vault", "DEMO-101", 228564)

describe("v2 vault path interface", () => {
  it("returns a human-first course tree without creating directories", () => {
    expect(course.home).toBe("/vault/demo-101/00 Home.md")
    expect(course.resources).toBe("/vault/demo-101/Resources")
    expect(course.other).toBe("/vault/demo-101/Other")
    expect(course.assignments).toBe("/vault/demo-101/Assignments")
    expect(course.assignmentsIndex).toBe("/vault/demo-101/Assignments/00 Assignments.md")
  })

  it("formats dated weeks and milestone containers chronologically", () => {
    const week = weekPaths(course, 1, "2026-09-21T09:00:00.000Z")
    expect(week.root).toBe("/vault/demo-101/Week 01 - Sep 21")
    expect(week.overview).toBe(`${week.root}/${vaultLayout.overview}`)
    expect(week.prep).toBe(`${week.root}/Prep`)
    expect(week.materials).toBe(`${week.root}/Materials`)
    expect(week.other).toBe(`${week.root}/Other`)

    const milestone = milestonePaths(course, 2, "Final Reflection")
    expect(milestone.root).toBe("/vault/demo-101/Milestone 02 - Final Reflection")
    expect(milestone.overview).toBe(`${milestone.root}/${vaultLayout.overview}`)
  })

  it("keeps assignment work together and excludes Canvas IDs from names", () => {
    const assignment = assignmentPaths(course, {
      title: "Case: Pricing / Trade-offs?",
      dueAt: "2026-10-02T23:59:00.000Z",
    })
    expect(assignment.root).toBe(
      "/vault/demo-101/Assignments/2026-10-02 - Case - Pricing - Trade-offs",
    )
    expect(assignment.prompt).toBe(`${assignment.root}/00 Prompt.md`)
    expect(assignment.materials).toBe(`${assignment.root}/Materials`)
    expect(assignment.drafts).toBe(`${assignment.root}/Drafts`)
    expect(assignment.final).toBe(`${assignment.root}/Final`)
    expect(assignment.feedback).toBe(`${assignment.root}/Feedback.md`)
    expect(assignment.root).not.toContain("228564")
  })

  it("routes v2 documents to their period or assignment subtree", () => {
    const week = weekPaths(course, 3, "2026-10-05")
    const moduleOverview = courseDocumentPath(course, {
      kind: vaultDocumentKinds.module,
      title: "Week 3",
      canvasId: "module-3",
      module: { number: 3, title: "Week 3", canvasId: "module-3", date: "2026-10-05" },
    })
    expect(moduleOverview).toBe(week.overview)

    const material = courseDocumentPath(course, {
      kind: vaultDocumentKinds.file,
      title: "Pricing Case.pdf",
      canvasId: "file-99",
      period: { kind: "week", number: 3, date: "2026-10-05" },
      bucket: "materials",
    })
    expect(material).toBe(`${week.materials}/Pricing Case.pdf.md`)

    const prompt = courseDocumentPath(course, {
      kind: vaultDocumentKinds.assignment,
      title: "Pricing Case",
      canvasId: "assignment-99",
      assignment: { title: "Pricing Case", dueAt: "2026-10-09" },
    })
    expect(prompt).toBe("/vault/demo-101/Assignments/2026-10-09 - Pricing Case/00 Prompt.md")
  })

  it("keeps a v1 adapter and uses the containing module identity", () => {
    const first = legacyCourseDocumentPath(course, {
      kind: vaultDocumentKinds.module,
      title: "Session page",
      canvasId: "item-1",
      module: { number: 1, title: "Session 1", canvasId: "module-1" },
    })
    const second = legacyCourseDocumentPath(course, {
      kind: vaultDocumentKinds.module,
      title: "Another page",
      canvasId: "item-2",
      module: { number: 1, title: "Session 1", canvasId: "module-1" },
    })
    expect(first).toContain("01-session-1-module-1")
    expect(second).toContain("01-session-1-module-1")
    expect(first).not.toContain("item-1")
    expect(second).not.toContain("item-2")

    const explicitLegacy = courseDocumentPath(course, {
      layout: "v1",
      kind: vaultDocumentKinds.assignment,
      title: "Pricing Case",
      canvasId: "assignment-99",
    })
    expect(explicitLegacy).toBe("/vault/demo-101/assignments/pricing-case.md")
  })
})
