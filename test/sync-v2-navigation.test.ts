import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"

import { syncCanvas } from "../src/canvas/sync.js"
import { createSchoolIndex } from "../src/store/db.js"
import { installCourseHandlers, server } from "./helpers/canvasMock.js"
import { client } from "./helpers/schoolConfig.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

describe("v2 Canvas navigation integration", () => {
  it("keeps a module-linked file in its session week when the file was created earlier", async () => {
    // Given: Canvas uploaded a case file during bulk course setup, then linked it
    // from a dated session module. The upload timestamp must not become a phantom
    // teaching week; the owning module is the authoritative period association.
    installCourseHandlers({
      modules: [
        {
          id: "11",
          name: "Session 1 (September 22)",
          position: 1,
          items: [
            {
              id: "111",
              title: "Pre-class case.txt",
              type: "File",
              content_id: "51",
            },
          ],
        },
      ],
      assignments: [
        {
          id: "21",
          name: "Session 1 discussion",
          due_at: "2026-09-25T17:00:00Z",
          all_dates: [],
        },
      ],
      submissions: {
        "21": {
          id: "61",
          assignment_id: "21",
          workflow_state: "unsubmitted",
        },
      },
      files: [
        {
          id: "51",
          display_name: "Pre-class case.txt",
          url: "https://canvas.test/files/51",
          size: 12,
          updated_at: "2026-08-24T17:00:00Z",
          content_type: "text/plain",
        },
      ],
      announcements: [],
      calendarEvents: [],
    })
    server.use(
      http.get("https://canvas.test/files/51", () =>
        HttpResponse.text("Case text.", { headers: { "content-type": "text/plain" } }),
      ),
    )
    const vaultPath = await temporaryDirectory("school-agent-v2-file-period-")
    const index = createSchoolIndex({ path: join(vaultPath, "school.sqlite") })

    await syncCanvas({
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 1,
      now: () => new Date("2026-09-01T12:00:00Z"),
    })

    const courseRoot = join(vaultPath, "fin-101")
    const topLevel = await readdir(courseRoot, { withFileTypes: true })
    expect(
      topLevel
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("Week "))
        .map((entry) => entry.name),
    ).toEqual(["Week 01 - Sep 21"])
    await expect(
      readFile(join(courseRoot, "Week 01 - Sep 21", "Prep", "Pre-class case.txt.md"), "utf8"),
    ).resolves.toContain("canvas_id: '51'")
    await expect(readFile(join(courseRoot, "00 Home.md"), "utf8")).resolves.not.toContain("Aug 24")
    index.close()
  })

  it("routes an undated utility module outside the Week namespace", async () => {
    // Given: a Canvas utility module has no session, unlock, or other reliable
    // period signal. Its Canvas position is navigation order, not a week number.
    installCourseHandlers({
      modules: [{ id: "11", name: "Canvas Help for Students", position: 1, items: [] }],
      assignments: [],
      submissions: {},
      files: [],
      announcements: [],
      calendarEvents: [],
    })
    const vaultPath = await temporaryDirectory("school-agent-v2-undated-module-")
    const index = createSchoolIndex({ path: join(vaultPath, "school.sqlite") })

    await syncCanvas({
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 1,
      now: () => new Date("2026-09-23T12:00:00Z"),
    })

    const courseRoot = join(vaultPath, "fin-101")
    const topLevel = await readdir(courseRoot, { withFileTypes: true })
    expect(
      topLevel.filter((entry) => entry.isDirectory() && entry.name.startsWith("Week ")),
    ).toHaveLength(0)
    await expect(
      readFile(join(courseRoot, "Other", "Canvas Help for Students.md"), "utf8"),
    ).resolves.toContain("canvas_id: '11'")
    index.close()
  })

  it("shares a calendar week for two dated sessions and writes navigation at sync end", async () => {
    installCourseHandlers({
      modules: [
        { id: "11", name: "Session 1 (September 22)", position: 1 },
        { id: "12", name: "Session 2 (September 24)", position: 2 },
      ],
    })
    const vaultPath = await temporaryDirectory("school-agent-v2-navigation-")
    const index = createSchoolIndex({ path: join(vaultPath, "school.sqlite") })

    const report = await syncCanvas({
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 1,
      now: () => new Date("2026-09-23T12:00:00Z"),
    })

    const courseRoot = join(vaultPath, "fin-101")
    const weekRoot = join(courseRoot, "Week 01 - Sep 21")
    await expect(stat(join(courseRoot, "00 Home.md"))).resolves.toBeDefined()
    await expect(stat(join(weekRoot, "00 Overview.md"))).resolves.toBeDefined()
    await expect(
      readFile(join(weekRoot, "Other", "Session 1 (September 22).md"), "utf8"),
    ).resolves.toContain("Session 1")
    await expect(
      readFile(join(weekRoot, "Other", "Session 2 (September 24).md"), "utf8"),
    ).resolves.toContain("Session 2")
    await expect(
      readFile(join(courseRoot, "Assignments", "2026-10-01 - Case memo", "00 Prompt.md"), "utf8"),
    ).resolves.toContain("Apply the framework.")
    await expect(
      readFile(join(courseRoot, "Assignments", "2026-10-01 - Case memo", "Feedback.md"), "utf8"),
    ).resolves.toContain("Strong synthesis")

    const weekEntries = await readdir(weekRoot)
    expect(weekEntries.sort()).toEqual(["00 Overview.md", "Other"])
    await expect(readFile(join(courseRoot, "00 Home.md"), "utf8")).resolves.toContain(
      "Week 01 - Sep 21",
    )
    expect(report.courses[0]?.status).toBe("synced")
    index.close()
  })
})
