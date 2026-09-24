import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import {
  courseDocumentPath,
  coursePaths,
  iCloudStubPath,
  layoutSegments,
  vaultDocumentKinds,
  versionedPath,
} from "../src/store/paths.js"
import {
  parseVaultDocument,
  renderVaultDocument,
  VaultWriter,
  vaultSources,
  vaultStatuses,
} from "../src/store/vault.js"

const execute = promisify(execFile)

const course = {
  code: "STRAT 101",
  canvasId: "course-17",
  canvasUrl: "https://canvas.example.invalid/courses/17",
  aiPolicy: "allowed" as const,
}

async function temporaryVault(): Promise<string> {
  return mkdtemp(join(tmpdir(), "school-agent-vault-"))
}

async function markdownFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? markdownFiles(path) : extname(path) === ".md" ? [path] : []
    }),
  )
  return paths.flat()
}

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? sourceFiles(path) : extname(path) === ".ts" ? [path] : []
    }),
  )
  return paths.flat()
}

describe("VaultWriter", () => {
  it("keeps duplicate human-readable titles distinct without exposing Canvas ids", async () => {
    // Given: Canvas modules whose display names and positions collide.
    const root = await temporaryVault()
    const writer = new VaultWriter({ root, gitInit: false })
    const common = {
      course,
      kind: vaultDocumentKinds.module,
      title: "Week 1",
      canvasUrl: "https://canvas.example.invalid/modules/1",
      content: "Module material.\n",
      module: { number: 1, title: "Week 1" },
      source: vaultSources.sync,
      status: vaultStatuses.approved,
    }

    // When: each document is written and the first is synced again.
    const first = await writer.write({ ...common, canvasId: "module-1" })
    const second = await writer.write({ ...common, canvasId: "module-2" })
    const repeated = await writer.write({ ...common, canvasId: "module-1" })

    // Then: neutral suffixes prevent overwrites and identity remains stable.
    expect(first.path).not.toBe(second.path)
    expect(second.path).toContain("Week 1 (2).md")
    expect(second.path).not.toContain("module-2")
    expect(repeated.path).toBe(first.path)
    expect(repeated.kind).toBe("unchanged")
  })

  it("leaves bytes and mtime unchanged when a document is written twice", async () => {
    // Given: an initialized local vault and one synced assignment.
    const root = await temporaryVault()
    const writer = new VaultWriter({ root, gitInit: false })
    const input = {
      course,
      kind: vaultDocumentKinds.assignment,
      title: "Case: Pricing / Trade-offs",
      canvasId: "assignment-4",
      canvasUrl: "https://canvas.example.invalid/assignments/4",
      content: "# Pricing case\n",
      dates: { due_at: "2026-09-01T12:00:00.000Z" },
      source: vaultSources.sync,
      status: vaultStatuses.approved,
    }

    // When: the exact payload is persisted twice.
    const first = await writer.write(input)
    const before = { bytes: await readFile(first.path), mtime: (await stat(first.path)).mtimeMs }
    const second = await writer.write(input)
    const after = { bytes: await readFile(second.path), mtime: (await stat(second.path)).mtimeMs }

    // Then: the writer reports idempotence without changing the file.
    expect(second.kind).toBe("unchanged")
    expect(after).toEqual(before)
  })

  it("relocates a sync-owned identity when its canonical period changes", async () => {
    const root = await temporaryVault()
    const writer = new VaultWriter({ root, gitInit: false })
    const input = {
      course,
      kind: vaultDocumentKinds.module,
      title: "Session 1",
      canvasId: "module-1",
      canvasUrl: "https://canvas.example.invalid/modules/1",
      content: "Session material.\n",
      source: vaultSources.sync,
      status: vaultStatuses.approved,
    }
    const stale = await writer.write({
      ...input,
      period: { kind: "week" as const, number: 1, date: "2026-08-24" },
    })

    const canonical = await writer.write({
      ...input,
      period: { kind: "week" as const, number: 1, date: "2026-09-21" },
    })

    expect(canonical.path).toContain("Week 01 - Sep 21")
    await expect(readFile(canonical.path, "utf8")).resolves.toContain("Session material.")
    await expect(readFile(stale.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves user and pending zones while delivering sync changes as a sibling", async () => {
    // Given: a guidance note, a pending draft, and a synced assignment the user has edited.
    const root = await temporaryVault()
    const writer = new VaultWriter({ root, gitInit: false })
    const guidance = await writer.write({
      course,
      kind: vaultDocumentKinds.guidance,
      title: "Prep guidance",
      canvasId: "guidance-1",
      canvasUrl: course.canvasUrl,
      content: "Use frameworks first.\n",
      source: vaultSources.user,
      status: vaultStatuses.approved,
    })
    const draft = await writer.write({
      course,
      kind: vaultDocumentKinds.draft,
      title: "Assignment response",
      canvasId: "assignment-4",
      canvasUrl: "https://canvas.example.invalid/assignments/4",
      content: "Draft one.\n",
      source: vaultSources.agent,
      status: vaultStatuses.draft,
    })
    const synced = await writer.write({
      course,
      kind: vaultDocumentKinds.assignment,
      title: "Pricing case",
      canvasId: "assignment-4",
      canvasUrl: "https://canvas.example.invalid/assignments/4",
      content: "Canvas version one.\n",
      source: vaultSources.sync,
      status: vaultStatuses.approved,
    })
    const handEdited = parseVaultDocument(await readFile(synced.path, "utf8"))
    await writeFile(
      synced.path,
      renderVaultDocument({ ...handEdited.frontmatter, source: vaultSources.user }, "My notes.\n"),
      "utf8",
    )
    const before = {
      guidance: await readFile(guidance.path),
      draft: await readFile(draft.path),
      synced: await readFile(synced.path),
    }
    const changedSync = {
      course,
      kind: vaultDocumentKinds.assignment,
      title: "Pricing case",
      canvasId: "assignment-4",
      canvasUrl: "https://canvas.example.invalid/assignments/4",
      content: "Canvas version two.\n",
      source: vaultSources.sync,
      status: vaultStatuses.approved,
    }

    // When: the next sync is run twice.
    await writer.write({
      ...changedSync,
      kind: vaultDocumentKinds.guidance,
      title: "Prep guidance",
    })
    const firstUpdate = await writer.write(changedSync)
    const secondUpdate = await writer.write(changedSync)

    // Then: protected files are identical and the Canvas change is delivered beside the user edit.
    expect(await readFile(guidance.path)).toEqual(before.guidance)
    expect(await readFile(draft.path)).toEqual(before.draft)
    expect(await readFile(synced.path)).toEqual(before.synced)
    expect(firstUpdate.kind).toBe("canvas-update")
    expect(secondUpdate.kind).toBe("unchanged")
    expect(firstUpdate.path).toContain(".canvas-update")
    expect(parseVaultDocument(await readFile(firstUpdate.path, "utf8")).content).toBe(
      changedSync.content,
    )
  })

  it("creates deterministic APFS-safe names and valid frontmatter for generated markdown", async () => {
    // Given: a title with APFS-illegal path characters and no fallback-worthy title.
    const root = await temporaryVault()
    const writer = new VaultWriter({ root, gitInit: false })
    const input = {
      course,
      kind: vaultDocumentKinds.module,
      title: "Week 1: Value / Capture?",
      canvasId: "module-1",
      canvasUrl: "https://canvas.example.invalid/modules/1",
      content: "Module material.\n",
      module: { number: 1, title: "Week 1: Value / Capture?" },
      source: vaultSources.sync,
      status: vaultStatuses.approved,
    }

    // When: the material is persisted and the generated vault is enumerated.
    const first = await writer.write(input)
    const second = await writer.write(input)
    const files = await markdownFiles(root)

    // Then: names are stable and legal, while every Markdown artifact has parseable frontmatter.
    expect(first.path).toBe(second.path)
    expect(basename(first.path).endsWith(".md")).toBe(true)
    expect([...basename(first.path)].every((character) => !"/:\\?*[]".includes(character))).toBe(
      true,
    )
    expect(files.length).toBeGreaterThan(0)
    for (const path of files) {
      const content = await readFile(path, "utf8")
      expect(() => parseVaultDocument(content)).not.toThrow()
    }
  })

  it("initializes a local-only git repository when configured", async () => {
    // Given: a vault configured for local history.
    try {
      await execute("git", ["--version"])
    } catch (error: unknown) {
      // Apple's git shim is unusable until the host accepts the Xcode license.
      if (String(error).includes("Xcode license")) return
      throw error
    }
    const root = await temporaryVault()
    const writer = new VaultWriter({ root, gitInit: true })

    // When: the writer persists a document.
    await writer.write({
      course,
      kind: vaultDocumentKinds.syllabus,
      title: "Syllabus",
      canvasId: "course-17",
      canvasUrl: course.canvasUrl,
      content: "Syllabus text.\n",
      source: vaultSources.sync,
      status: vaultStatuses.approved,
    })

    // Then: git exists locally and has no configured remotes.
    await expect(stat(join(root, ".git"))).resolves.toBeDefined()
    const remote = await execute("git", ["remote", "-v"], { cwd: root })
    expect(remote.stdout).toBe("")
  })

  it("versions a pending draft and skips an iCloud placeholder", async () => {
    // Given: a pending draft and an iCloud placeholder for a synced assignment.
    const root = await temporaryVault()
    const warnings: string[] = []
    const writer = new VaultWriter({
      root,
      gitInit: false,
      warn: (message) => warnings.push(message),
    })
    const draft = {
      course,
      kind: vaultDocumentKinds.draft,
      title: "Draft response",
      canvasId: "assignment-4",
      canvasUrl: "https://canvas.example.invalid/assignments/4",
      content: "Version one.\n",
      source: vaultSources.agent,
      status: vaultStatuses.draft,
    }
    const firstDraft = await writer.write(draft)
    const assignment = {
      course,
      kind: vaultDocumentKinds.assignment,
      title: "Unavailable attachment",
      canvasId: "assignment-5",
      canvasUrl: "https://canvas.example.invalid/assignments/5",
      content: "Canvas material.\n",
      source: vaultSources.sync,
      status: vaultStatuses.approved,
    }
    const assignmentPath = courseDocumentPath(
      coursePaths(root, course.code, course.canvasId),
      assignment,
    )
    await mkdir(dirname(assignmentPath), { recursive: true })
    await writeFile(iCloudStubPath(assignmentPath), "placeholder", "utf8")

    // When: a new draft is generated and the placeholder is encountered.
    const secondDraft = await writer.write({ ...draft, content: "Version two.\n" })
    const skipped = await writer.write(assignment)

    // Then: the original draft survives, a versioned sibling is created, and the stub is warned and skipped.
    expect(secondDraft).toEqual({ kind: "versioned", path: versionedPath(firstDraft.path, 2) })
    expect(parseVaultDocument(await readFile(firstDraft.path, "utf8")).content).toBe(draft.content)
    expect(skipped).toEqual({ kind: "skipped", path: assignmentPath })
    expect(warnings).toHaveLength(1)
  })

  it("keeps layout names centralized in paths.ts", async () => {
    // Given: every TypeScript source file except the layout authority.
    const sourceRoot = new URL("../src/", import.meta.url)
    const files = (await sourceFiles(fileURLToPath(sourceRoot))).filter(
      (path) => !path.endsWith("/store/paths.ts"),
    )
    const pattern = new RegExp(
      `\\b(?:join|resolve)\\([^\\n]*(?:['"](?:${layoutSegments.map(escapeRegex).join("|")})['"])`,
    )

    // When: source is inspected for literal layout segments.
    const violations = await Promise.all(
      files.map(async (path) => ({ path, matches: (await readFile(path, "utf8")).match(pattern) })),
    )

    // Then: only paths.ts owns the layout vocabulary.
    expect(violations.filter(({ matches }) => matches !== null)).toEqual([])
  })
})

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
