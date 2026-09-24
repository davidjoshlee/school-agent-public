import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
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
  readonly destinationRoot: string
  readonly files: Readonly<Record<string, string>>
}> {
  const courseRoot = join(root, course)
  const destinationRoot = join(root, "course-101")
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
  return { courseRoot, destinationRoot, files }
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
      "course-101/Milestone 01 - Sep 21/00 Overview.md",
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
        "course-101/_index.md",
        "course-101/Assignments/2026-10-02 - Synthetic Case Analysis/00 Prompt.md",
        "course-101/Assignments/2026-10-02 - Synthetic Case Analysis/Drafts/response.md",
        "course-101/Resources/Syllabus.md",
        "course-101/Week 01 - Sep 21/Materials/case-notes.md",
        "course-101/Week 01 - Sep 21/Materials/reading.md",
        "course-101/Week 01 - Sep 21/00 Overview.md",
        "course-101/Week 01 - Sep 21/Prep/week-2026-09-21.md",
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
    expect(result.moved).toHaveLength(8)
    const assignment = await readFile(
      join(
        fixture.destinationRoot,
        "Assignments",
        "2026-10-02 - Synthetic Case Analysis",
        "00 Prompt.md",
      ),
      "utf8",
    )
    expect(assignment).toBe(original)
    expect(await readFile(join(fixture.destinationRoot, "_index.md"), "utf8")).toContain(
      "canvas_id: index",
    )
    // Migration moves every file but intentionally leaves empty legacy
    // directories in place; pruning them is not part of the migration plan.
    expect((await readdir(fixture.courseRoot)).sort()).toEqual([
      "assignments",
      "drafts",
      "files",
      "modules",
      "prep",
    ])
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
    const destination = join(fixture.destinationRoot, "Resources", "Syllabus.md")
    const protectedBytes = document(
      "user-syllabus",
      "00-syllabus.md",
      "My syllabus notes\n",
      {},
      { source: "user", status: "approved" },
    )
    await mkdir(join(fixture.destinationRoot, "Resources"), { recursive: true })
    await writeFile(join(fixture.destinationRoot, "_index.md"), await readFile(fixture.files.home))
    await writeFile(destination, protectedBytes)

    const plan = await planVaultMigration({ root })
    expect(plan.ready).toBe(false)
    expect(
      plan.conflicts.some(
        (action) => action.destinationRelative === "course-101/Resources/Syllabus.md",
      ),
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
      .filter((path) => path.startsWith("course-101/Other/note"))
      .sort()

    expect(destinations).toEqual(["course-101/Other/note (2).md", "course-101/Other/note.md"])
    expect(destinations.join("\n")).not.toContain("canvas-secret")
  })

  it("blocks migration when the course ID cannot be confirmed from its index URL", async () => {
    const root = await temporaryDirectory("school-agent-vault-migration-ambiguous-id-")
    const fixture = await writeLegacyFixture(root)
    await writeFile(
      fixture.files.home,
      document("index", "_index.md", "# Course home\n").replace(
        "https://canvas.example.invalid/courses/101",
        "https://canvas.example.invalid/",
      ),
    )

    const plan = await planVaultMigration({ root })

    expect(plan.ready).toBe(false)
    expect(plan.conflicts[0]?.reason).toContain("canvas_url has no course ID")
    expect(await readFile(fixture.files.assignment, "utf8")).toContain("Synthetic Case")
    await expect(readFile(fixture.destinationRoot, "utf8")).rejects.toThrow()
  })

  it("blocks a destination directory whose index identifies a different course", async () => {
    const root = await temporaryDirectory("school-agent-vault-migration-root-conflict-")
    const fixture = await writeLegacyFixture(root)
    await mkdir(fixture.destinationRoot, { recursive: true })
    const conflictingIndex = (await readFile(fixture.files.home, "utf8"))
      .replace("canvas_id: index", "canvas_id: '202'")
      .replace("courses/101", "courses/202")
    await writeFile(join(fixture.destinationRoot, "_index.md"), conflictingIndex)

    const plan = await planVaultMigration({ root })

    expect(plan.ready).toBe(false)
    expect(plan.conflicts[0]?.reason).toContain("does not confirm Canvas course 101")
    expect(await readFile(fixture.files.assignment, "utf8")).toContain("Synthetic Case")
  })

  it("preflights conflicts for hidden files before moving any planned content", async () => {
    const root = await temporaryDirectory("school-agent-vault-migration-hidden-conflict-")
    const fixture = await writeLegacyFixture(root)
    const hiddenSource = join(fixture.courseRoot, ".local-state")
    const hiddenDestination = join(fixture.destinationRoot, ".local-state")
    await writeFile(hiddenSource, "legacy hidden state\n")
    await mkdir(fixture.destinationRoot, { recursive: true })
    await writeFile(join(fixture.destinationRoot, "_index.md"), await readFile(fixture.files.home))
    await writeFile(hiddenDestination, "protected destination\n")

    const plan = await planVaultMigration({ root })

    expect(plan.ready).toBe(false)
    expect(
      plan.conflicts.some((action) => action.destinationRelative === "course-101/.local-state"),
    ).toBe(true)
    await expect(executeVaultMigration(plan)).rejects.toThrow("destination conflict")
    expect(await readFile(fixture.files.assignment, "utf8")).toContain("Synthetic Case")
    expect(await readFile(hiddenSource, "utf8")).toBe("legacy hidden state\n")
    expect(await readFile(hiddenDestination, "utf8")).toBe("protected destination\n")
  })

  it("keeps the v1 marker and requires inspection after a mid-migration failure", async () => {
    const root = await temporaryDirectory("school-agent-vault-migration-partial-")
    const fixture = await writeLegacyFixture(root)
    const plan = await planVaultMigration({ root })
    const firstMove = plan.moves[0]
    const secondMove = plan.moves[1]
    if (firstMove === undefined || secondMove === undefined) {
      throw new Error("Expected at least two planned migration moves")
    }
    await writeFile(secondMove.source, "changed after planning\n")

    await expect(executeVaultMigration(plan)).rejects.toThrow("Source changed after planning")

    expect(await readFile(firstMove.destination, "utf8")).toBeTruthy()
    expect(await readFile(join(root, "_meta", "layout.json"), "utf8")).toBe(
      '{"layout_version":1}\n',
    )
    const retryPlan = await planVaultMigration({ root })
    expect(retryPlan.ready).toBe(false)
    expect(retryPlan.conflicts.length).toBeGreaterThan(0)
    expect(await readFile(fixture.files.home, "utf8")).toContain("Course home")
  })

  it("blocks two legacy roots whose confirmed indexes claim the same Canvas course", async () => {
    const root = await temporaryDirectory("school-agent-vault-migration-duplicate-course-id-")
    const first = await writeLegacyFixture(root)
    const secondRoot = join(root, "renamed-code")
    await mkdir(secondRoot, { recursive: true })
    await writeFile(join(secondRoot, "_index.md"), await readFile(first.files.home, "utf8"))
    await writeFile(
      join(secondRoot, "00-syllabus.md"),
      document("syllabus-2", "00-syllabus.md", "# Other syllabus\n"),
    )

    const plan = await planVaultMigration({ root })

    expect(plan.ready).toBe(false)
    expect(
      plan.conflicts.some((action) => action.reason.includes("Multiple legacy course roots")),
    ).toBe(true)
    expect(await readFile(first.files.assignment, "utf8")).toContain("Synthetic Case")
  })
})
