import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { createSchoolIndex } from "../src/store/db.js"
import { vaultLayout } from "../src/store/paths.js"
import {
  assertCourseRootLayoutReady,
  executeCourseRootMigration,
  planCourseRootMigration,
} from "../src/store/vault-course-root-migration.js"
import { createVaultFrontmatter, renderVaultDocument } from "../src/store/vault-document.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

async function indexedLegacyVault(sourceName = "f26-demo-101-01") {
  const root = await temporaryDirectory("school-agent-root-migration-")
  const source = join(root, sourceName)
  const destination = join(root, "DEMO101")
  const indexPath = join(root, "school.sqlite")
  await mkdir(join(root, "_meta"))
  await writeFile(
    join(root, "_meta", "layout.json"),
    JSON.stringify({ layout_version: vaultLayout.version, migrated_from: 1 }),
  )
  await mkdir(source)
  await writeFile(
    join(source, "_index.md"),
    renderVaultDocument(
      createVaultFrontmatter({
        canvasId: "1001",
        canvasUrl: "https://canvas.example.edu/courses/1001",
        type: "_index.md",
        content: "Course index",
        source: "sync",
        status: "final",
        aiPolicy: "allowed",
      }),
      "Course index",
    ),
  )
  await writeFile(join(source, "notes.md"), "Private notes stay here.")
  const index = createSchoolIndex({ path: indexPath })
  index.upsertCourse({
    canvasId: "1001",
    name: "F26-DEMO-101-01 - Example",
    courseCode: "F26-DEMO-101-01",
    workflowState: "available",
    vaultPath: source,
  })
  index.upsertModule({
    canvasId: "2001",
    courseCanvasId: "1001",
    name: "Week 1",
    position: 1,
    vaultPath: join(source, "notes.md"),
  })
  index.close()
  return { root, source, destination, indexPath }
}

describe("course-root migration", () => {
  it("moves the whole folder, rebases indexed paths, and marks the naming version", async () => {
    const fixture = await indexedLegacyVault()
    await expect(assertCourseRootLayoutReady(fixture.root)).rejects.toThrow("needs migration")
    const plan = await planCourseRootMigration(fixture.root, fixture.indexPath)
    expect(plan.ready).toBe(true)
    expect(plan.moves).toHaveLength(1)
    expect(plan.moves[0]?.destination).toBe(fixture.destination)

    await executeCourseRootMigration(plan, fixture.indexPath)

    await expect(stat(fixture.source)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(fixture.destination, "notes.md"), "utf8")).toBe(
      "Private notes stay here.",
    )
    const db = new Database(fixture.indexPath)
    expect(
      (
        db.prepare("SELECT vault_path FROM courses WHERE canvas_id = '1001'").get() as {
          vault_path: string
        }
      ).vault_path,
    ).toBe(fixture.destination)
    expect(
      (
        db.prepare("SELECT vault_path FROM modules WHERE canvas_id = '2001'").get() as {
          vault_path: string
        }
      ).vault_path,
    ).toBe(join(fixture.destination, "notes.md"))
    db.close()
    await expect(assertCourseRootLayoutReady(fixture.root)).resolves.toBeUndefined()
    expect(await readFile(join(fixture.root, "_meta", "layout.json"), "utf8")).toContain(
      '"migrated_from": 1',
    )
    const repeat = await planCourseRootMigration(fixture.root, fixture.indexPath)
    expect(repeat.moves).toHaveLength(0)
  })

  it("reports an occupied destination and leaves both roots untouched", async () => {
    const fixture = await indexedLegacyVault()
    await mkdir(fixture.destination)
    const plan = await planCourseRootMigration(fixture.root, fixture.indexPath)
    expect(plan.ready).toBe(false)
    expect(plan.conflicts).toContain(`${fixture.destination}: destination already exists.`)
    await expect(executeCourseRootMigration(plan, fixture.indexPath)).rejects.toThrow("conflicts")
    expect(await readFile(join(fixture.source, "notes.md"), "utf8")).toBe(
      "Private notes stay here.",
    )
  })

  it("also migrates an ID-named legacy root", async () => {
    const fixture = await indexedLegacyVault("course-1001")
    const plan = await planCourseRootMigration(fixture.root, fixture.indexPath)
    expect(plan.ready).toBe(true)
    expect(plan.moves[0]?.destination).toBe(fixture.destination)
  })

  it("does not mark an unindexed course folder as migrated", async () => {
    const fixture = await indexedLegacyVault()
    await mkdir(join(fixture.root, "untracked-course"))
    const plan = await planCourseRootMigration(fixture.root, fixture.indexPath)
    expect(plan.ready).toBe(false)
    expect(plan.conflicts.join(" ")).toContain("not owned by a local index row")
  })

  it("blocks writes to an unmarked vault that already contains course folders", async () => {
    const root = await temporaryDirectory("school-agent-unmarked-roots-")
    await mkdir(join(root, "course-1001"))
    await expect(assertCourseRootLayoutReady(root)).rejects.toThrow("needs migration")
  })

  it("rejects a changed course after planning without moving it", async () => {
    const fixture = await indexedLegacyVault()
    const plan = await planCourseRootMigration(fixture.root, fixture.indexPath)
    await writeFile(join(fixture.source, "_index.md"), "Changed since planning")
    await expect(executeCourseRootMigration(plan, fixture.indexPath)).rejects.toThrow(
      "changed after planning",
    )
    expect(await readFile(join(fixture.source, "notes.md"), "utf8")).toBe(
      "Private notes stay here.",
    )
    await expect(stat(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
