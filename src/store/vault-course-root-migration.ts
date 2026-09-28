import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import Database from "better-sqlite3"

import { coursePaths, vaultLayout, vaultPaths } from "./paths.js"
import { parseVaultDocument } from "./vault-document.js"

type CourseRow = {
  readonly canvas_id: string
  readonly name: string | null
  readonly course_code: string | null
  readonly vault_path: string | null
}

export type CourseRootMove = {
  readonly canvasId: string
  readonly source: string
  readonly destination: string
  readonly indexDigest: string
}

export type CourseRootPlan = {
  readonly root: string
  readonly moves: readonly CourseRootMove[]
  readonly conflicts: readonly string[]
  readonly ready: boolean
}

export class CourseRootMigrationError extends Error {
  readonly name = "CourseRootMigrationError"
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function folderCode(row: CourseRow): string {
  const code = row.course_code?.trim()
  if (code && !/^course-\d+$/i.test(code)) return code
  return row.name?.trim() || `course-${row.canvas_id}`
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

function layoutContent(previous: string | null): string {
  const metadata = previous === null ? {} : (JSON.parse(previous) as Record<string, unknown>)
  return `${JSON.stringify(
    {
      ...metadata,
      layout_version: vaultLayout.version,
      course_root_version: vaultLayout.courseRootVersion,
    },
    null,
    2,
  )}\n`
}

/** Reject writes that would fork an old vault into duplicate course roots. */
export async function assertCourseRootLayoutReady(rootPath: string): Promise<void> {
  const root = resolve(rootPath)
  const layoutPath = vaultPaths(root).metadata.layout
  try {
    const layout = JSON.parse(await readFile(layoutPath, "utf8")) as {
      layout_version?: unknown
      course_root_version?: unknown
    }
    if (
      layout.layout_version !== vaultLayout.version ||
      layout.course_root_version !== vaultLayout.courseRootVersion
    ) {
      if (layout.layout_version === vaultLayout.version) {
        const entries = await readdir(root, { withFileTypes: true })
        if (
          !entries.some(
            (entry) =>
              entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."),
          )
        ) {
          return
        }
      }
      throw new CourseRootMigrationError(
        `Vault layout needs migration. Run school vault ${layout.layout_version === vaultLayout.version ? "migrate-roots" : "migrate"} before writing: ${layoutPath}`,
      )
    }
    return
  } catch (error: unknown) {
    if (!missing(error)) {
      if (error instanceof CourseRootMigrationError) throw error
      throw new CourseRootMigrationError(`Invalid vault layout metadata: ${layoutPath}`)
    }
  }
  // Scratch vaults have no marker, but existing course folders must never be
  // silently forked into a second set of roots.
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (missing(error)) return []
    throw error
  })
  if (
    entries.some(
      (entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."),
    )
  ) {
    throw new CourseRootMigrationError(
      `Vault layout needs migration. Run school vault migrate-roots before writing: ${layoutPath}`,
    )
  }
}

/** Plan whole-directory renames and index rebases without changing the vault. */
export async function planCourseRootMigration(
  rootPath: string,
  indexPath: string,
): Promise<CourseRootPlan> {
  const root = resolve(rootPath)
  const moves: CourseRootMove[] = []
  const conflicts: string[] = []
  const metadataPath = vaultPaths(root).metadata.layout
  try {
    const layout = JSON.parse(await readFile(metadataPath, "utf8")) as {
      layout_version?: unknown
    }
    if (layout.layout_version !== vaultLayout.version) {
      conflicts.push(`${metadataPath}: document layout version differs.`)
      return { root, moves, conflicts, ready: false }
    }
  } catch (error: unknown) {
    if (!missing(error)) {
      conflicts.push(`${metadataPath}: invalid layout metadata.`)
      return { root, moves, conflicts, ready: false }
    }
  }
  if (!(await fileExists(indexPath))) {
    const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if (missing(error)) return []
      throw error
    })
    if (
      entries.some(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."),
      )
    ) {
      conflicts.push(`${root}: course folders exist but the local index is missing.`)
    }
    return { root, moves, conflicts, ready: conflicts.length === 0 }
  }
  const ReadOnlyDatabase = Database as unknown as new (
    filename: string,
    options: { readonly: boolean; fileMustExist: boolean },
  ) => Database
  const db = new ReadOnlyDatabase(indexPath, { readonly: true, fileMustExist: true })
  const indexedRoots = new Set<string>()
  try {
    const rows = db
      .prepare("SELECT canvas_id, name, course_code, vault_path FROM courses ORDER BY canvas_id")
      .all() as CourseRow[]
    for (const row of rows) {
      if (row.vault_path === null) continue
      const source = resolve(row.vault_path)
      if (dirname(source) !== root) continue
      indexedRoots.add(source)
      const destination = coursePaths(root, folderCode(row), row.canvas_id).root
      let sourceStat: Awaited<ReturnType<typeof lstat>>
      try {
        sourceStat = await lstat(source)
      } catch (error: unknown) {
        if (missing(error)) continue // Stale archived index entry, not a root to move.
        throw error
      }
      if (!sourceStat.isDirectory()) {
        conflicts.push(`${source}: indexed course root is not a directory.`)
        continue
      }
      const indexFile = join(source, vaultLayout.index)
      try {
        const content = await readFile(indexFile, "utf8")
        const document = parseVaultDocument(content, indexFile)
        const urlId = /(?:^|\/)courses\/([^/]+)/.exec(
          new URL(document.frontmatter.canvas_url).pathname,
        )?.[1]
        if (document.frontmatter.canvas_id !== row.canvas_id || urlId !== row.canvas_id) {
          conflicts.push(`${source}: _index.md Canvas identity does not match the local index.`)
          continue
        }
        if (source !== destination) {
          moves.push({
            canvasId: row.canvas_id,
            source,
            destination,
            indexDigest: digest(content),
          })
        }
      } catch (error: unknown) {
        conflicts.push(`${source}: cannot verify _index.md (${String(error)}).`)
      }
    }
  } finally {
    db.close()
  }
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith("_") ||
      entry.name.startsWith(".") ||
      entry.name === "old"
    )
      continue
    const path = join(root, entry.name)
    if (!indexedRoots.has(path)) {
      conflicts.push(`${path}: course-like root is not owned by a local index row.`)
    }
  }
  const destinations = new Set<string>()
  for (const move of moves) {
    if (destinations.has(move.destination)) {
      conflicts.push(`${move.destination}: multiple courses map to this name.`)
    }
    destinations.add(move.destination)
    if (await fileExists(move.destination)) {
      conflicts.push(`${move.destination}: destination already exists.`)
    }
  }
  return { root, moves, conflicts, ready: conflicts.length === 0 }
}

/** Apply only a conflict-free plan, with rollback on an ordinary failure. */
export async function executeCourseRootMigration(
  plan: CourseRootPlan,
  indexPath: string,
): Promise<readonly CourseRootMove[]> {
  if (!plan.ready) throw new CourseRootMigrationError("Course-root migration has conflicts.")
  const metadataPath = vaultPaths(plan.root).metadata.layout
  const priorMetadata = await readFile(metadataPath, "utf8").catch((error: unknown) => {
    if (missing(error)) return null
    throw error
  })
  if (priorMetadata !== null) {
    const prior = JSON.parse(priorMetadata) as { layout_version?: unknown }
    if (prior.layout_version !== vaultLayout.version) {
      throw new CourseRootMigrationError(
        "Document layout version differs; use the matching School Agent version to migrate it.",
      )
    }
  }
  const ExistingDatabase = Database as unknown as new (
    filename: string,
    options: { fileMustExist: boolean },
  ) => Database
  const db = new ExistingDatabase(indexPath, { fileMustExist: true })
  const moved: CourseRootMove[] = []
  let rebased = false
  const temporaryMetadata = `${metadataPath}.${randomUUID()}.tmp`
  try {
    for (const move of plan.moves) {
      if (await fileExists(move.destination)) {
        throw new CourseRootMigrationError(
          `${move.destination}: destination appeared after planning.`,
        )
      }
      if (!(await lstat(move.source)).isDirectory()) {
        throw new CourseRootMigrationError(`${move.source}: source is no longer a directory.`)
      }
      const indexFile = join(move.source, vaultLayout.index)
      if (digest(await readFile(indexFile, "utf8")) !== move.indexDigest) {
        throw new CourseRootMigrationError(`${move.source}: course changed after planning.`)
      }
      const row = db
        .prepare("SELECT vault_path FROM courses WHERE canvas_id = ?")
        .get(move.canvasId) as { vault_path: string | null } | undefined
      if (row?.vault_path !== move.source) {
        throw new CourseRootMigrationError(`${move.source}: indexed path changed after planning.`)
      }
    }
    for (const move of plan.moves) {
      if (await fileExists(move.destination)) {
        throw new CourseRootMigrationError(
          `${move.destination}: destination appeared during migration.`,
        )
      }
      await rename(move.source, move.destination)
      moved.push(move)
    }
    rebase(db, moved, false)
    rebased = true
    await mkdir(dirname(metadataPath), { recursive: true })
    await writeFile(temporaryMetadata, layoutContent(priorMetadata), { flag: "wx" })
    await rename(temporaryMetadata, metadataPath)
    return moved
  } catch (error: unknown) {
    const rollbackFailures: string[] = []
    if (rebased) {
      try {
        rebase(db, moved, true)
      } catch (rollbackError: unknown) {
        rollbackFailures.push(`index: ${String(rollbackError)}`)
      }
    }
    for (const move of [...moved].reverse()) {
      try {
        await rename(move.destination, move.source)
      } catch (rollbackError: unknown) {
        rollbackFailures.push(`${move.canvasId}: ${String(rollbackError)}`)
      }
    }
    try {
      await unlink(temporaryMetadata)
    } catch (rollbackError: unknown) {
      if (!missing(rollbackError)) rollbackFailures.push(`metadata: ${String(rollbackError)}`)
    }
    throw new CourseRootMigrationError(
      `Course-root migration failed: ${String(error)}. ${rollbackFailures.length === 0 ? "All moved roots were rolled back." : `Rollback failures: ${rollbackFailures.join("; ")}.`}`,
    )
  } finally {
    db.close()
  }
}

function rebase(db: Database, moves: readonly CourseRootMove[], reverse: boolean): void {
  db.transaction(() => {
    for (const move of moves) {
      const from = reverse ? move.destination : move.source
      const to = reverse ? move.source : move.destination
      for (const table of ["courses", "modules", "assignments", "announcements", "files"]) {
        db.prepare(
          `UPDATE ${table} SET vault_path = ? || substr(vault_path, ?) WHERE vault_path = ? OR substr(vault_path, 1, ?) = ?`,
        ).run(to, from.length + 1, from, from.length + 1, `${from}/`)
      }
    }
  })()
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error: unknown) {
    if (missing(error)) return false
    throw error
  }
}
