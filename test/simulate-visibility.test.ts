import { describe, expect, it } from "vitest"

import {
  computeVisibility,
  courseSetupCutoff,
  type ModuleDatesById,
} from "../src/engines/simulate-visibility.js"

describe("computeVisibility precedence", () => {
  it("trusts an explicit own unlock_at over everything else", () => {
    const result = computeVisibility(
      { unlock_at: "2025-01-01T00:00:00.000Z", due_at: "2025-06-01T00:00:00.000Z" },
      undefined,
      new Map(),
      null,
    )
    expect(result).toEqual({ visibleAt: "2025-01-01", signal: "unlock_at" })
  })

  it("trusts an explicit own posted_at when there is no unlock_at", () => {
    const result = computeVisibility(
      { posted_at: "2025-02-02T00:00:00.000Z" },
      undefined,
      new Map(),
      null,
    )
    expect(result).toEqual({ visibleAt: "2025-02-02", signal: "posted_at" })
  })

  it("falls back to the containing module's unlock_at", () => {
    const moduleDatesById: ModuleDatesById = new Map([
      ["mod-1", { unlock_at: "2025-03-01T00:00:00.000Z" }],
    ])
    const result = computeVisibility({}, "mod-1", moduleDatesById, null)
    expect(result).toEqual({ visibleAt: "2025-03-01", signal: "module_release" })
  })

  it("falls back to the containing module's session_at minus the 7-day lead", () => {
    const moduleDatesById: ModuleDatesById = new Map([["mod-1", { session_at: "2025-10-16" }]])
    const result = computeVisibility({}, "mod-1", moduleDatesById, null)
    expect(result).toEqual({ visibleAt: "2025-10-09", signal: "module_release" })
  })

  it("treats a module document's own session_at as its module release date", () => {
    // A module document about itself carries session_at directly in its own
    // `dates` (see moduleDates in sync-render.ts), not via module_canvas_id.
    const result = computeVisibility({ session_at: "2025-10-16" }, undefined, new Map(), null)
    expect(result).toEqual({ visibleAt: "2025-10-09", signal: "module_release" })
  })

  it("falls back to own due_at when there is no release signal", () => {
    const result = computeVisibility(
      { due_at: "2025-04-04T00:00:00.000Z" },
      undefined,
      new Map(),
      null,
    )
    expect(result).toEqual({ visibleAt: "2025-04-04", signal: "due_at" })
  })

  it("trusts own created_at only when it postdates the course setup cutoff", () => {
    const trusted = computeVisibility(
      { created_at: "2025-05-01T00:00:00.000Z" },
      undefined,
      new Map(),
      "2025-04-01",
    )
    expect(trusted).toEqual({ visibleAt: "2025-05-01", signal: "created_at" })

    const bulkSetup = computeVisibility(
      { created_at: "2025-03-01T00:00:00.000Z" },
      undefined,
      new Map(),
      "2025-04-01",
    )
    expect(bulkSetup).toEqual({ visibleAt: null, signal: "unknown" })
  })

  it("yields unknown when no setup cutoff is computable at all, rather than trusting created_at", () => {
    const result = computeVisibility(
      { created_at: "2025-03-01T00:00:00.000Z" },
      undefined,
      new Map(),
      null,
    )
    expect(result).toEqual({ visibleAt: null, signal: "unknown" })
  })

  it("yields unknown for a genuinely dateless document", () => {
    expect(computeVisibility({}, undefined, new Map(), null)).toEqual({
      visibleAt: null,
      signal: "unknown",
    })
  })

  it("demonstrates the fixed leak: an item unassociated with any module, created at bulk course setup, is NOT visible even though the course has later structure", () => {
    // This is the exact shape of the original bug: Canvas creates every
    // assignment the day the course shell is built, so a bare created_at
    // fallback would make everything "visible" from day one. Here the item
    // itself carries no module_canvas_id (rule b doesn't apply), so it falls
    // to rule (d) — and the course's own module session_at establishes a
    // setup cutoff well after this item's created_at, correctly rejecting it.
    const moduleDatesById: ModuleDatesById = new Map([["mod-8", { session_at: "2025-10-16" }]])
    const cutoff = courseSetupCutoff(moduleDatesById, [])
    const result = computeVisibility(
      { created_at: "2025-08-15T00:00:00.000Z" }, // bulk course-setup day
      undefined,
      moduleDatesById,
      cutoff,
    )
    expect(result.signal).not.toBe("created_at")
    expect(result.visibleAt).toBeNull()
  })
})

describe("courseSetupCutoff", () => {
  it("is 14 days before the earliest module session_at or assignment due_at in the course", () => {
    const moduleDatesById: ModuleDatesById = new Map([
      ["mod-1", { session_at: "2025-09-01" }],
      ["mod-2", { session_at: "2025-10-16" }],
    ])
    expect(courseSetupCutoff(moduleDatesById, ["2025-09-15T00:00:00.000Z"])).toBe("2025-08-18")
  })

  it("is null when the course has no module session_at or assignment due_at anywhere", () => {
    expect(courseSetupCutoff(new Map(), [null, undefined])).toBeNull()
  })
})
