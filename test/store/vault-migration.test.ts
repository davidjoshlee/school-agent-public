import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"
import {
  createVaultFrontmatter,
  renderVaultDocument,
  vaultSources,
  vaultStatuses,
} from "../../src/store/vault-document.js"
import {
  executeVaultMigration,
  migrateVault,
  planVaultMigration,
} from "../../src/store/vault-migration.js"
import { temporaryDirectory } from "../helpers/tempDir.js"

const course = "demo-101"
const courseUrl = "https://canvas.example.invalid/courses/101"

function document(
  canvasId: string,
  type: string,
  content: string,
  dates: Record<string, string | null> = {},
  options: {
    readonly source?: "sync" | "agent" | "user"
    readonly status?: "draft" | "approved" | "final"
  } = {},
): string {
  return renderVaultDocument(
    createVaultFrontmatter({
      canvasId,
      canvasUrl: courseUrl,
      type,
      content,
      dates,
      source: options.source ?? vaultSources.sync,
      status: options.status ?? vaultStatuses.final,
      aiPolicy: "allowed",
    }),
    content,
  )
}

async function writeLegacyFixture(root: string): Promise<{
  readonly courseRoot: string
  readonly files: Readonly<Record<string, string>>
}> {
  const courseRoot = join(root, course)
  const files = {
    home: join(courseRoot, "_index.md"),
    syllabus: join(courseRoot, "00-syllabus.md"),
    module: join(courseRoot, "modules", "01-week-1-11", "week-1.md"),
    moduleItem: join(courseRoot, "modules", "01-week-1-p1", "reading.md"),
    assignment: join(courseRoot, "assignments", "synthetic-case-analysis.md"),
    file: join(courseRoot, "files", "case-notes.md"),
    prep: join(courseRoot, "prep", "week-2026-09-21.md"),
    draft: join(courseRoot, "drafts", "response.md"),
  }
  await Promise.all(
    Object.values(files).map((path) => mkdir(join(path, ".."), { recursive: true })),
  )
  await writeFile(files.home, document("index", "_index.md", "# Course home\n"))
  await writeFile(files.syllabus, document("syllabus", "00-syllabus.md", "# Syllabus\n"))
  await writeFile(
    files.module,
    document("11", "modules", "# Week 1\n", { session_at: "2026-09-21T16:00:00.000Z" }),
  )
  await writeFile(
    files.moduleItem,
    document("p1", "modules", "# Required reading\n", { session_at: "2026-09-21" }),
  )
  const moduleItemBody = await readFile(files.moduleItem, "utf8")
  await writeFile(
    files.moduleItem,
    moduleItemBody.replace("type: modules", "type: modules\nmodule_canvas_id: '11'"),
  )
  await writeFile(
    files.assignment,
    document("a1", "assignments", "# Synthetic Case\n", { due_at: "2026-10-02T23:59:00.000Z" }),
  )
  await writeFile(
    files.file,
    document("file-1", "files", "Case notes\n", {}, { source: vaultSources.sync }),
  )
  await writeFile(
    files.prep,
    document("prep-week-2026-09-21", "prep", "# Prep\n", { period: "week-2026-09-21" }),
  )
  // module_canvas_id makes a formerly flat file unambiguously belong to Week 1.
  const fileBody = await readFile(files.file, "utf8")
  await writeFile(
    files.file,
    fileBody.replace("type: files", "type: files\nmodule_canvas_id: '11'"),
  )
  await writeFile(
    files.draft,
    document("a1", "drafts", "Draft response\n", {}, { source: "agent", status: "draft" }),
  )
  await mkdir(join(root, "_meta"), { recursive: true })
  await writeFile(join(root, "_meta", "layout.json"), '{"layout_version":1}\n')
  return { courseRoot, files }
}

describe("vault v1 -> v2 migration", () => {
  it("uses milestone containers when legacy module titles identify a milestone", async () => {
    const root = await temporaryDirectory("school-agent-vault-migration-milestone-")
    const fixture = await writeLegacyFixture(root)
    await writeFile(
      fixture.files.module,
      document("11", "modules", "# Milestone 1: Review\n", {
        session_at: "2026-09-21T16:00:00.000Z",
      }),
    )

    const plan = await planVaultMigration({ root })

    expect(plan.moves.map((action) => action.destinationRelative)).toContain(
      "Milestone 01 - Sep 21/00 Overview.md",
    )
  })

  it("plans without touching the vault and maps content to navigable destinations", async () => {
    const root = await temporaryDirectory("school-agent-vault-migration-plan-")
    const fixture = await writeLegacyFixture(root)
    const before = await readFile(fixture.files.assignment)

    const plan = await planVaultMigration({ root })

    expect(plan.sourceVersion).toBe(1)
    expect(plan.targetVersion).toBe(2)
    expect(plan.ready).toBe(true)
    expect(plan.moves.map((action) => action.destinationRelative).sort()).toEqual(
      [
        "Assignments/2026-10-02 - Synthetic Case Analysis/00 Prompt.md",
        "Assignments/2026-10-02 - Synthetic Case Analysis/Drafts/response.md",
        "Resources/Syllabus.md",
        "Week 01 - Sep 21/Materials/case-notes.md",
        "Week 01 - Sep 21/Materials/reading.md",
        "Week 01 - Sep 21/00 Overview.md",
        "Week 01 - Sep 21/Prep/week-2026-09-21.md",
      ].sort(),
    )
    expect(await readFile(fixture.files.assignment)).toEqual(before)
    expect(await readFile(fixture.files.home)).toBeTruthy()
    expect(await readFile(join(root, "_meta", "layout.json"), "utf8")).toBe(
      '{"layout_version":1}\n',
    )
  })

  it("applies moves byte-for-byte, preserves frontmatter IDs, and is idempotent", async () => {
    const root = await temporaryDirectory("school-agent-vault-migration-apply-")
    const fixture = await writeLegacyFixture(root)
    const original = await readFile(fixture.files.assignment, "utf8")
    const result = await migrateVault({
      root,
      apply: true,
      now: () => new Date("2026-09-21T20:00:00.000Z"),
    })

    expect(result.applied).toBe(true)
    expect(result.moved).toHaveLength(7)
    const assignment = await readFile(
      join(
        fixture.courseRoot,
        "Assignments",
        "2026-10-02 - Synthetic Case Analysis",
        "00 Prompt.md",
      ),
      "utf8",
    )
    expect(assignment).toBe(original)
    expect(await readFile(join(root, "_meta", "layout.json"), "utf8")).toContain(
      '"layout_version": 2',
    )
    expect(await readFile(join(root, "_meta", "layout.json"), "utf8")).toContain(
      '"migrated_from": 1',
    )

    const rerun = await migrateVault({ root, apply: true })
    expect(rerun.applied).toBe(false)
    expect(rerun.plan.actions).toHaveLength(0)
  })

  it("does not overwrite a protected destination or advance layout metadata", async () => {
    const root = await temporaryDirectory("school-agent-vault-migration-conflict-")
    const fixture = await writeLegacyFixture(root)
    const destination = join(fixture.courseRoot, "Resources", "Syllabus.md")
    const protectedBytes = document(
      "user-syllabus",
      "00-syllabus.md",
      "My syllabus notes\n",
      {},
      { source: "user", status: "approved" },
    )
    await mkdir(join(fixture.courseRoot, "Resources"), { recursive: true })
    await writeFile(destination, protectedBytes)

    const plan = await planVaultMigration({ root })
    expect(plan.ready).toBe(false)
    expect(
      plan.conflicts.some((action) => action.destinationRelative === "Resources/Syllabus.md"),
    ).toBe(true)
    await expect(executeVaultMigration(plan)).rejects.toThrow("destination conflict")
    expect(await readFile(destination)).toEqual(Buffer.from(protectedBytes))
    expect(await readFile(join(root, "_meta", "layout.json"), "utf8")).toBe(
      '{"layout_version":1}\n',
    )
    expect(await readFile(fixture.files.syllabus, "utf8")).not.toBe(protectedBytes)
  })

  it("uses neutral ordinal suffixes when human-readable destinations collide", async () => {
    const root = await temporaryDirectory("school-agent-vault-migration-duplicate-")
    const fixture = await writeLegacyFixture(root)
    const first = join(fixture.courseRoot, "misc-a", "note.md")
    const second = join(fixture.courseRoot, "misc-b", "note.md")
    await mkdir(join(first, ".."), { recursive: true })
    await mkdir(join(second, ".."), { recursive: true })
    await writeFile(first, document("canvas-secret-1", "unknown", "First note\n"))
    await writeFile(second, document("canvas-secret-2", "unknown", "Second note\n"))

    const plan = await planVaultMigration({ root })
    const destinations = plan.moves
      .map((action) => action.destinationRelative)
      .filter((path) => path.startsWith("Other/note"))
      .sort()

    expect(destinations).toEqual(["Other/note (2).md", "Other/note.md"])
    expect(destinations.join("\n")).not.toContain("canvas-secret")
  })
})
