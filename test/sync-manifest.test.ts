import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { syncCanvas } from "../src/canvas/sync.js"
import { parseManifest } from "../src/engines/retrieve-files.js"
import { createSchoolIndex } from "../src/store/db.js"
import { parseVaultDocument } from "../src/store/vault.js"
import { installCourseHandlers } from "./helpers/canvasMock.js"
import { client } from "./helpers/schoolConfig.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

describe("Canvas sync course manifest", () => {
  it("writes stable manifest rows that the retrieval parser reads after every sync", async () => {
    // Given: a Canvas course with a dated assignment and dateless module materials.
    installCourseHandlers({
      course: {
        id: "1",
        name: "Pricing",
        course_code: "MANIFEST-101",
        syllabus_body: "Course syllabus",
      },
      modules: [
        {
          id: "11",
          name: "Week 1",
          position: 1,
          items: [{ id: "41", title: "Intro", type: "Page", page_url: "intro" }],
        },
      ],
      assignments: [
        {
          id: "21",
          name: "Case memo",
          description: "Apply the framework.",
          due_at: null,
          created_at: "2026-02-18T17:00:00Z",
          unlock_at: null,
          updated_at: "2026-02-18T17:00:00Z",
          all_dates: [],
          html_url: "https://canvas.test/courses/1/assignments/21",
        },
      ],
      submissions: { "21": { id: "61", assignment_id: "21", workflow_state: "unsubmitted" } },
      pages: { intro: { page_id: "41", url: "intro", title: "Intro", body: "Welcome page" } },
      announcements: [],
      calendarEvents: [],
      files: [],
      discussions: [],
      quizzes: [],
    })
    const vaultPath = await temporaryDirectory("school-agent-sync-manifest-")
    const index = createSchoolIndex({ path: join(vaultPath, "school.sqlite") })
    const input = {
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 1,
    }

    try {
      await syncCanvas(input)
      const indexPath = join(vaultPath, "manifest-101", "_index.md")
      const first = await readFile(indexPath, "utf8")

      // When: the same course is synchronized again without source changes.
      await syncCanvas(input)
      const second = await readFile(indexPath, "utf8")
      const manifest = parseVaultDocument(second, indexPath)
      const entries = parseManifest(manifest.content)

      // Then: the generated table is byte-stable and exposes real artifacts to retrieval.
      expect(second).toBe(first)
      expect(manifest.frontmatter.source).toBe("sync")
      expect(manifest.frontmatter.content_hash).not.toBe(
        createHash("sha256").update("").digest("hex"),
      )
      expect(entries.map((entry) => entry.path)).toEqual([
        "00-syllabus.md",
        "assignments/case-memo.md",
        "modules/01-week-1-11/week-1.md",
        "modules/01-week-1-41/intro.md",
      ])
      expect(entries).toContainEqual({
        title: "Case memo",
        type: "assignments",
        dates: "2026-02-18",
        path: "assignments/case-memo.md",
        tokenEstimate: expect.any(Number),
        restricted: false,
      })
      expect(entries).toContainEqual({
        title: "Intro",
        type: "modules",
        dates: "unknown",
        path: "modules/01-week-1-41/intro.md",
        tokenEstimate: expect.any(Number),
        restricted: false,
      })
      expect(entries.every((entry) => entry.tokenEstimate >= 0)).toBe(true)
    } finally {
      index.close()
    }
  })
})
