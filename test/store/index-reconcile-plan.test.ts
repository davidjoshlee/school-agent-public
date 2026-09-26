import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import Database from "better-sqlite3"
import { describe, expect, it, vi } from "vitest"

import { runCli } from "../../src/cli.js"
import { createSchoolIndex } from "../../src/store/db.js"
import { planIndexReconciliation } from "../../src/store/index-reconcile-plan.js"
import { createVaultFrontmatter, renderVaultDocument } from "../../src/store/vault-document.js"
import { temporaryDirectory } from "../helpers/tempDir.js"

async function document(root: string, courseId: string, name: string, id: string, type: string) {
  const courseRoot = join(root, `course-${courseId}`)
  await mkdir(courseRoot, { recursive: true })
  const path = join(courseRoot, name)
  const content = `# Synthetic ${type}\n`
  await writeFile(
    path,
    renderVaultDocument(
      createVaultFrontmatter({
        canvasId: id,
        canvasUrl: `https://canvas.example.invalid/courses/${courseId}/${type}/${id}`,
        type,
        content,
        source: "sync",
        status: "final",
        aiPolicy: "allowed",
      }),
      content,
    ),
  )
  return path
}

async function course(root: string, id: string) {
  const courseRoot = join(root, `course-${id}`)
  await mkdir(courseRoot, { recursive: true })
  await document(root, id, "_index.md", id, "index")
  return courseRoot
}

describe("index reconciliation plan", () => {
  it("classifies unique, ambiguous, concluded, and unresolved rows without cross-course matches or writes", async () => {
    const root = await temporaryDirectory("index-reconcile-")
    const first = await course(root, "101")
    const second = await course(root, "202")
    const relocated = await document(root, "101", "moved-file.md", "f1", "files")
    await document(root, "202", "same-id-other-course.md", "f1", "files")
    await document(root, "101", "module-a.md", "m1", "modules")
    await document(root, "101", "module-b.md", "m1", "modules")
    await document(root, "101", "deleted-assignment.md", "a1", "assignments")
    const indexPath = join(root, "index.db")
    createSchoolIndex({ path: indexPath }).close()
    const db = new Database(indexPath)
    db.prepare("INSERT INTO courses (canvas_id, workflow_state, vault_path) VALUES (?, ?, ?)").run(
      "101",
      "available",
      first,
    )
    db.prepare("INSERT INTO courses (canvas_id, workflow_state, vault_path) VALUES (?, ?, ?)").run(
      "202",
      "available",
      second,
    )
    db.prepare("INSERT INTO courses (canvas_id, workflow_state, vault_path) VALUES (?, ?, ?)").run(
      "303",
      "completed",
      join(root, "course-303"),
    )
    db.prepare("INSERT INTO courses (canvas_id, workflow_state, vault_path) VALUES (?, ?, ?)").run(
      "404",
      "available",
      join(root, "course-404"),
    )
    db.prepare("INSERT INTO files (canvas_id, course_canvas_id, vault_path) VALUES (?, ?, ?)").run(
      "f1",
      "101",
      join(first, "old-file.md"),
    )
    db.prepare("INSERT INTO files (canvas_id, course_canvas_id, vault_path) VALUES (?, ?, ?)").run(
      "f2",
      "101",
      join(first, "missing-file.md"),
    )
    db.prepare(
      "INSERT INTO modules (canvas_id, course_canvas_id, vault_path) VALUES (?, ?, ?)",
    ).run("m1", "101", join(first, "missing-module.md"))
    db.prepare(
      "INSERT INTO assignments (canvas_id, course_canvas_id, vault_path, deleted) VALUES (?, ?, ?, ?)",
    ).run("a1", "101", join(first, "old-assignment.md"), 1)
    db.close()

    const before = await readFile(indexPath)
    const plan = await planIndexReconciliation({ vaultRoot: root, indexPath })
    expect(plan.dryRun).toBe(true)
    expect(plan.proposedRelinks).toBe(1)
    expect(plan.findings).toHaveLength(6)
    expect(plan.findings.find((finding) => finding.canvasId === "f1")).toMatchObject({
      status: "unique-relocation",
      candidates: [relocated],
    })
    expect(plan.findings.find((finding) => finding.canvasId === "m1")).toMatchObject({
      status: "ambiguous-relocation",
    })
    expect(plan.findings.find((finding) => finding.canvasId === "a1")).toMatchObject({
      status: "concluded-or-deleted",
    })
    expect(plan.findings.find((finding) => finding.canvasId === "303")).toMatchObject({
      status: "concluded-or-deleted",
    })
    expect(plan.findings.find((finding) => finding.canvasId === "404")).toMatchObject({
      status: "course-root-absent",
    })
    expect(plan.findings.find((finding) => finding.canvasId === "f2")).toMatchObject({
      status: "missing-local",
    })
    expect(await readFile(indexPath)).toEqual(before)
  })

  it("exposes the dry-run plan through the CLI without updating SQLite", async () => {
    const root = await temporaryDirectory("index-reconcile-cli-")
    const courseRoot = await course(root, "101")
    await document(root, "101", "relocated.md", "f1", "files")
    const indexPath = join(root, "index.db")
    createSchoolIndex({ path: indexPath }).close()
    const db = new Database(indexPath)
    db.prepare("INSERT INTO courses (canvas_id, vault_path) VALUES (?, ?)").run("101", courseRoot)
    db.prepare("INSERT INTO files (canvas_id, course_canvas_id, vault_path) VALUES (?, ?, ?)").run(
      "f1",
      "101",
      join(courseRoot, "old.md"),
    )
    db.close()
    const configPath = join(root, "school.config.json")
    await writeFile(
      configPath,
      JSON.stringify({ vault: { path: root, gitInit: false }, index: { path: indexPath } }),
    )
    const before = await readFile(indexPath)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      expect(await runCli(["--config", configPath, "vault", "reconcile-index", "--json"])).toBe(0)
      const plan = JSON.parse(log.mock.calls.map((call) => String(call[0])).join("\n"))
      expect(plan).toMatchObject({ dryRun: true, proposedRelinks: 1 })
      expect(await readFile(indexPath)).toEqual(before)
    } finally {
      log.mockRestore()
    }
  })
})
