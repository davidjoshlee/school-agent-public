import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"
import { listHomework, renderHomework, resolveCourseCodes } from "../../src/engines/homework.js"
import { createSchoolIndex } from "../../src/store/db.js"
import { coursePaths } from "../../src/store/paths.js"

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
    canvasId: "721",
    courseCanvasId: "1",
    name: "Case memo",
    dueAt: "2026-10-08T17:00:00Z",
    vaultPath: "course-1/Assignments/2026-10-08 - Case memo/00 Prompt.md",
    allDates: [],
  })
  index.upsertAssignment({
    canvasId: "722",
    courseCanvasId: "2",
    name: "Reflection",
    dueAt: "2026-10-06T17:00:00Z",
    vaultPath: "course-2/Assignments/2026-10-06 - Reflection/00 Prompt.md",
    allDates: [],
  })
  index.upsertAssignment({
    canvasId: "723",
    courseCanvasId: "1",
    name: "Later memo",
    dueAt: "2026-12-01T17:00:00Z",
    vaultPath: "course-1/Assignments/2026-12-01 - Later memo/00 Prompt.md",
    allDates: [],
  })
  return index
}

describe("homework engine", () => {
  it("lists only gradeable assignments due within the window, soonest first", async () => {
    // Given: two courses with assignments inside and outside a 14-day window.
    const index = populatedIndex()

    // When: homework is listed for the next 14 days.
    const rows = await listHomework({
      index,
      vaultRoot: await mkdtemp(join(tmpdir(), "school-agent-homework-")),
      days: 14,
      now: new Date("2026-10-05T00:00:00Z"),
      courseCodes: null,
    })

    // Then: only the two in-window assignments appear, soonest first, with ids for copy-pasting.
    expect(rows.map((row) => ({ canvasId: row.canvasId, courseCode: row.courseCode }))).toEqual([
      { canvasId: "722", courseCode: "LEAD-202" },
      { canvasId: "721", courseCode: "FIN-101" },
    ])
    index.close()
  })

  it("shows an existing draft's version when one exists, and no version when none does", async () => {
    // Given: a vault where one due assignment already has a v2 draft and the other has none.
    const index = populatedIndex()
    const vaultRoot = await mkdtemp(join(tmpdir(), "school-agent-homework-"))
    const drafts = coursePaths(vaultRoot, "FIN-101", "1").drafts
    await mkdir(drafts, { recursive: true })
    await writeFile(join(drafts, "case-memo.md"), "draft v1", "utf8")
    await writeFile(join(drafts, "case-memo.v2.md"), "draft v2", "utf8")

    // When: homework is listed.
    const rows = await listHomework({
      index,
      vaultRoot,
      days: 14,
      now: new Date("2026-10-05T00:00:00Z"),
      courseCodes: null,
    })

    // Then: the drafted assignment reports its highest version; the undrafted one reports none.
    const caseMemo = rows.find((row) => row.canvasId === "721")
    const reflection = rows.find((row) => row.canvasId === "722")
    expect(caseMemo?.draftVersion).toBe(2)
    expect(reflection?.draftVersion).toBeNull()
    await rm(vaultRoot, { recursive: true, force: true })
    index.close()
  })

  it("resolves --course by id or by code, and falls back to the allowlist without it", () => {
    // Given: an index with one course and a config recording it on the allowlist by Canvas id.
    const index = populatedIndex()
    const listConfig = { mode: "list" as const, allowlist: ["1"] }
    const autoConfig = { mode: "auto" as const, allowlist: [] }

    // When/Then: --course accepts either form, and the allowlist applies only in "list" mode.
    expect(resolveCourseCodes(index, autoConfig, "1")).toEqual(["FIN-101"])
    expect(resolveCourseCodes(index, autoConfig, "FIN-101")).toEqual(["FIN-101"])
    expect(resolveCourseCodes(index, listConfig, undefined)).toEqual(["FIN-101"])
    expect(resolveCourseCodes(index, autoConfig, undefined)).toBeNull()
    index.close()
  })

  it("prints a clear 'nothing due' message for an empty window", () => {
    // Given/When: rendering zero rows.
    const output = renderHomework([], 14)

    // Then: the message is plain and unambiguous, never an error.
    expect(output).toBe("Nothing due in the next 14 day(s).")
  })

  it("prints the exact next-draft command under the table", () => {
    // Given: a rendered row set.
    const output = renderHomework(
      [
        {
          canvasId: "721",
          title: "Case memo",
          courseCode: "FIN-101",
          dueAt: "…",
          draftVersion: null,
        },
      ],
      14,
    )

    // Then: the copy-pasteable draft command names the assignment id.
    expect(output).toContain("Run: school draft 721")
  })
})

describe("school homework CLI", () => {
  it("delegates --draft to the shared assignment draft entry point, unmodified", async () => {
    // Given: the shared draft pipeline replaced with a spy so no model is ever invoked.
    vi.resetModules()
    vi.doMock("../../src/engines/assignment-cli.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/engines/assignment-cli.js")>()
      return {
        ...actual,
        runAssignmentDraft: vi.fn(async () => ({
          runId: "run-1",
          path: "/vault/drafts/case-memo.md",
        })),
      }
    })
    const { runCli } = await import("../../src/cli.js")
    const { runAssignmentDraft } = await import("../../src/engines/assignment-cli.js")
    const root = await mkdtemp(join(tmpdir(), "school-agent-homework-cli-"))
    const configPath = join(root, "school.config.json")
    await writeFile(
      configPath,
      JSON.stringify({
        vault: { path: root, gitInit: false },
        index: { path: join(root, "index.db") },
      }),
      "utf8",
    )
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      // When: `homework --draft <id>` runs.
      const exitCode = await runCli(["--config", configPath, "homework", "--draft", "721"])

      // Then: it delegates to the exact same entry point `draft` uses, and prints its result unchanged.
      expect(exitCode).toBe(0)
      expect(runAssignmentDraft).toHaveBeenCalledWith(expect.anything(), undefined, "721")
      expect(log).toHaveBeenCalledWith("run-1\t/vault/drafts/case-memo.md")
    } finally {
      log.mockRestore()
      vi.doUnmock("../../src/engines/assignment-cli.js")
      await rm(root, { recursive: true, force: true })
    }
  })

  it("lists nothing due and exits 0 through the CLI", async () => {
    // Given: a config whose index has no courses at all, with the CLI freshly reloaded.
    vi.resetModules()
    const root = await mkdtemp(join(tmpdir(), "school-agent-homework-cli-"))
    const configPath = join(root, "school.config.json")
    await writeFile(
      configPath,
      JSON.stringify({
        vault: { path: root, gitInit: false },
        index: { path: join(root, "index.db") },
      }),
      "utf8",
    )
    const { runCli } = await import("../../src/cli.js")
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      // When: homework is listed with nothing indexed.
      const exitCode = await runCli(["--config", configPath, "homework"])

      // Then: it says so plainly and exits cleanly.
      expect(exitCode).toBe(0)
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Nothing due"))
    } finally {
      log.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
