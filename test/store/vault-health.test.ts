import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"

import { createSchoolIndex } from "../../src/store/db.js"
import { planVaultHealth } from "../../src/store/vault-health.js"
import { temporaryDirectory } from "../helpers/tempDir.js"

describe("vault health audit", () => {
  it("reports duplicate weeks, stale paths, missing files, and unexpected roots without writing", async () => {
    const root = await temporaryDirectory("vault-health-")
    const expected = join(root, "course-101")
    const unexpected = join(root, "old-course")
    const indexPath = join(root, "school.db")
    await mkdir(join(expected, "Week 1 - Sep 21"), { recursive: true })
    await mkdir(join(expected, "Week 01 - Sep 28"), { recursive: true })
    await mkdir(unexpected, { recursive: true })
    await writeFile(join(unexpected, "_index.md"), "synthetic manifest")
    createSchoolIndex({ path: indexPath }).close()
    const db = new Database(indexPath)
    db.prepare("INSERT INTO courses (canvas_id, vault_path) VALUES (?, ?)").run("101", expected)
    db.prepare(
      "INSERT INTO modules (canvas_id, course_canvas_id, vault_path) VALUES (?, ?, ?)",
    ).run("m1", "101", join(expected, "gone-week"))
    db.prepare("INSERT INTO files (canvas_id, course_canvas_id, vault_path) VALUES (?, ?, ?)").run(
      "f1",
      "101",
      join(expected, "Week 1 - Sep 21", "gone.md"),
    )
    db.close()

    const dbBefore = await readFile(indexPath)
    const plan = await planVaultHealth({ root, indexPath })
    expect(plan.dryRun).toBe(true)
    expect(plan.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining([
        "duplicate-week-directory",
        "stale-indexed-path",
        "missing-indexed-file",
        "unexpected-course-root",
      ]),
    )
    expect(plan.repairPlan.length).toBe(plan.issues.length)
    expect(plan.repairPlan.every((action) => action.automatic === false)).toBe(true)
    expect(await readFile(indexPath)).toEqual(dbBefore)
  })
})
