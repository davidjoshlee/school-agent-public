import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"

import { createSchoolIndex } from "../../src/store/db.js"
import {
  executeCourseRootMigration,
  planCourseRootMigration,
} from "../../src/store/vault-course-root-migration.js"
import { createVaultFrontmatter, renderVaultDocument } from "../../src/store/vault-document.js"
import { temporaryDirectory } from "../helpers/tempDir.js"

async function fixture(root: string, name = "legacy-course", id = "101", urlId = id) {
  const source = join(root, name)
  await mkdir(join(root, "_meta"), { recursive: true })
  await mkdir(join(source, "Week 01", "Prep"), { recursive: true })
  await writeFile(join(root, "_meta", "layout.json"), '{"layout_version":2}\n')
  const content = "# Synthetic course\n"
  await writeFile(
    join(source, "_index.md"),
    renderVaultDocument(
      createVaultFrontmatter({
        canvasId: id,
        canvasUrl: `https://canvas.example.invalid/courses/${urlId}`,
        type: "index",
        content,
        source: "sync",
        status: "final",
        aiPolicy: "allowed",
      }),
      content,
    ),
  )
  await writeFile(join(source, "Week 01", "Prep", "notes.md"), "user-owned exact bytes\n")
  return source
}

describe("v2 course-root migration", () => {
  it("moves each complete course tree, preserves bytes, and rebases index paths", async () => {
    const root = await temporaryDirectory("school-agent-root-move-")
    const source = await fixture(root)
    const destination = join(root, "course-101")
    const indexPath = join(root, "school.db")
    createSchoolIndex({ path: indexPath }).close()
    const db = new Database(indexPath)
    db.prepare("INSERT INTO courses (canvas_id, vault_path) VALUES (?, ?)").run("101", source)
    db.prepare(
      "INSERT INTO modules (canvas_id, course_canvas_id, vault_path) VALUES (?, ?, ?)",
    ).run("module-1", "101", join(source, "Week 01"))
    db.prepare("INSERT INTO files (canvas_id, course_canvas_id, vault_path) VALUES (?, ?, ?)").run(
      "file-1",
      "101",
      join(source, "Week 01", "Prep", "notes.md"),
    )
    db.close()

    const before = await readFile(join(source, "Week 01", "Prep", "notes.md"))
    const plan = await planCourseRootMigration(root)
    expect(plan.ready).toBe(true)
    expect(plan.moves).toHaveLength(1)
    expect(existsSync(source)).toBe(true) // planning is read-only
    await executeCourseRootMigration(plan, indexPath)

    expect(existsSync(source)).toBe(false)
    expect(await readFile(join(destination, "Week 01", "Prep", "notes.md"))).toEqual(before)
    const updated = new Database(indexPath)
    for (const [table, suffix] of [
      ["courses", ""],
      ["modules", "/Week 01"],
      ["files", "/Week 01/Prep/notes.md"],
    ] as const) {
      const row = updated.prepare(`SELECT vault_path FROM ${table}`).get() as { vault_path: string }
      expect(row.vault_path).toBe(`${destination}${suffix}`)
    }
    updated.close()
    expect((await planCourseRootMigration(root)).moves).toHaveLength(0)
  })

  it("refuses occupied destinations without moving source files", async () => {
    const root = await temporaryDirectory("school-agent-root-conflict-")
    const source = await fixture(root)
    await mkdir(join(root, "course-101"))
    const plan = await planCourseRootMigration(root)
    expect(plan.ready).toBe(false)
    expect(plan.conflicts).toHaveLength(1)
    await expect(executeCourseRootMigration(plan, join(root, "missing.db"))).rejects.toThrow(
      "nothing moved",
    )
    expect(existsSync(source)).toBe(true)
  })

  it("refuses mismatched and duplicate Canvas identities", async () => {
    const root = await temporaryDirectory("school-agent-root-identity-")
    await fixture(root, "wrong-url", "101", "999")
    expect((await planCourseRootMigration(root)).ready).toBe(false)
    const secondRoot = await temporaryDirectory("school-agent-root-duplicate-")
    await fixture(secondRoot, "first", "101")
    await fixture(secondRoot, "second", "101")
    expect((await planCourseRootMigration(secondRoot)).ready).toBe(false)
  })

  it("rejects a stale plan before the first move", async () => {
    const root = await temporaryDirectory("school-agent-root-stale-")
    const source = await fixture(root)
    const plan = await planCourseRootMigration(root)
    await writeFile(join(source, "_index.md"), "changed")
    await expect(executeCourseRootMigration(plan, join(root, "missing.db"))).rejects.toThrow(
      "changed since planning",
    )
    expect(existsSync(source)).toBe(true)
  })

  it("rejects a copied index whose absolute paths belong to another vault", async () => {
    const root = await temporaryDirectory("school-agent-root-wrong-index-")
    const source = await fixture(root)
    const indexPath = join(root, "school.db")
    createSchoolIndex({ path: indexPath }).close()
    const db = new Database(indexPath)
    db.prepare("INSERT INTO courses (canvas_id, vault_path) VALUES (?, ?)").run(
      "101",
      "/different-vault/legacy-course",
    )
    db.close()
    const plan = await planCourseRootMigration(root)
    await expect(executeCourseRootMigration(plan, indexPath)).rejects.toThrow(
      "does not point at its planned source root",
    )
    expect(existsSync(source)).toBe(true)
    expect(existsSync(join(root, "course-101"))).toBe(false)
  })
})
