import { createHash } from "node:crypto"
import { lstat, readdir, readFile, rename } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

import Database from "better-sqlite3"

import { coursePaths, vaultLayout } from "./paths.js"
import { parseVaultDocument } from "./vault-document.js"

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

/**
 * Older v2 vaults used course-code roots. The current layout uses the stable
 * Canvas ID. This plan never writes and refuses ambiguous or occupied targets.
 */
export async function planCourseRootMigration(rootPath: string): Promise<CourseRootPlan> {
  const root = resolve(rootPath)
  const layout = JSON.parse(
    await readFile(join(root, vaultLayout.metadata, vaultLayout.layoutMetadata), "utf8"),
  ) as {
    layout_version?: unknown
  }
  if (layout.layout_version !== 2) {
    throw new CourseRootMigrationError("Course-root migration requires a v2 vault.")
  }
  const moves: CourseRootMove[] = []
  const conflicts: string[] = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue
    const source = join(root, entry.name)
    const indexPath = join(source, vaultLayout.index)
    let index: string
    try {
      index = await readFile(indexPath, "utf8")
    } catch (error: unknown) {
      if (isMissing(error)) continue
      throw error
    }
    try {
      const { frontmatter } = parseVaultDocument(index, indexPath)
      const canvasId = frontmatter.canvas_id
      const urlId = /(?:^|\/)courses\/([^/]+)/.exec(new URL(frontmatter.canvas_url).pathname)?.[1]
      if (urlId !== canvasId) {
        conflicts.push(`${entry.name}: _index.md Canvas ID does not match its course URL.`)
        continue
      }
      const destination = coursePaths(root, entry.name, canvasId).root
      if (source === destination) continue
      moves.push({
        canvasId,
        source,
        destination,
        indexDigest: createHash("sha256").update(index).digest("hex"),
      })
    } catch (error: unknown) {
      conflicts.push(`${entry.name}: invalid course identity (${String(error)}).`)
    }
  }
  const targetCounts = new Map<string, number>()
  for (const move of moves) {
    targetCounts.set(move.destination, (targetCounts.get(move.destination) ?? 0) + 1)
  }
  for (const move of moves) {
    if ((targetCounts.get(move.destination) ?? 0) > 1) {
      conflicts.push(`${basename(move.destination)}: multiple course roots map to this Canvas ID.`)
    }
    if (await exists(move.destination)) {
      conflicts.push(`${basename(move.destination)}: destination already exists.`)
    }
  }
  return { root, moves, conflicts, ready: conflicts.length === 0 }
}

/** Rename each complete course tree, then rebase the derived SQLite paths. */
export async function executeCourseRootMigration(
  plan: CourseRootPlan,
  indexPath: string,
): Promise<readonly CourseRootMove[]> {
  if (!plan.ready) {
    throw new CourseRootMigrationError(
      `Course-root migration blocked by ${plan.conflicts.length} conflict(s); nothing moved.`,
    )
  }
  // Re-check all identities and destinations before the first mutation.
  for (const move of plan.moves) {
    const sourceStat = await lstat(move.source)
    if (!sourceStat.isDirectory())
      throw new CourseRootMigrationError(`${move.source} is not a directory.`)
    const index = await readFile(join(move.source, vaultLayout.index), "utf8")
    if (createHash("sha256").update(index).digest("hex") !== move.indexDigest) {
      throw new CourseRootMigrationError(`${move.source} changed since planning; plan again.`)
    }
    if (await exists(move.destination)) {
      throw new CourseRootMigrationError(
        `${move.destination} appeared since planning; nothing moved.`,
      )
    }
  }
  const indexStat = await lstat(indexPath)
  if (!indexStat.isFile()) throw new CourseRootMigrationError(`${indexPath} is not an index file.`)
  const db = new Database(indexPath)
  const moved: CourseRootMove[] = []
  try {
    for (const move of plan.moves) {
      const row = db
        .prepare("SELECT vault_path FROM courses WHERE canvas_id = ?")
        .get(move.canvasId) as { vault_path: string | null } | undefined
      if (row?.vault_path !== move.source) {
        throw new CourseRootMigrationError(
          `Index course ${move.canvasId} does not point at its planned source root; nothing moved.`,
        )
      }
    }
    for (const move of plan.moves) {
      if (await exists(move.destination))
        throw new CourseRootMigrationError(`${move.destination} appeared during migration.`)
      await rename(move.source, move.destination)
      moved.push(move)
    }
    db.transaction(() => {
      for (const move of moved) {
        for (const table of [
          "courses",
          "modules",
          "assignments",
          "announcements",
          "files",
        ] as const) {
          db.prepare(
            `UPDATE ${table} SET vault_path = ? || substr(vault_path, ?) WHERE vault_path = ? OR substr(vault_path, 1, ?) = ?`,
          ).run(
            move.destination,
            move.source.length + 1,
            move.source,
            move.source.length + 1,
            `${move.source}/`,
          )
        }
      }
    })()
    return moved
  } catch (error: unknown) {
    const rollbackFailures: string[] = []
    for (const move of [...moved].reverse()) {
      try {
        await rename(move.destination, move.source)
      } catch (rollbackError: unknown) {
        rollbackFailures.push(`${move.canvasId}: ${String(rollbackError)}`)
      }
    }
    throw new CourseRootMigrationError(
      `Course-root migration failed: ${String(error)}.${rollbackFailures.length === 0 ? " All moved roots were rolled back." : ` Rollback failed for ${rollbackFailures.join(", ")}. Restore the backup before retrying.`}`,
    )
  } finally {
    db.close()
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error: unknown) {
    if (isMissing(error)) return false
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
