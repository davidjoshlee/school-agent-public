import { lstat, readdir, readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import Database from "better-sqlite3"

import { coursePaths, vaultLayout } from "./paths.js"
import { parseVaultDocument } from "./vault-document.js"

export type IndexedTable = "courses" | "modules" | "assignments" | "announcements" | "files"
export type ReconcileStatus =
  | "unique-relocation"
  | "ambiguous-relocation"
  | "concluded-or-deleted"
  | "course-root-absent"
  | "missing-local"

export type IndexReconcileFinding = {
  readonly table: IndexedTable
  readonly canvasId: string
  readonly courseCanvasId: string
  readonly indexedPath: string
  readonly indexedPathScope: "inside-vault" | "outside-vault"
  readonly status: ReconcileStatus
  readonly candidates: readonly string[]
  readonly note: string
}

export type IndexReconcilePlan = {
  readonly vaultRoot: string
  readonly indexPath: string
  readonly findings: readonly IndexReconcileFinding[]
  readonly proposedRelinks: number
  readonly dryRun: true
}

type IndexedRow = {
  canvas_id: string
  course_canvas_id?: string
  vault_path: string | null
  workflow_state?: string | null
  deleted?: number
}

const documentTables = ["modules", "assignments", "announcements", "files"] as const

/** Suggests index-only relinks. It never edits the vault or database. */
export async function planIndexReconciliation(options: {
  readonly vaultRoot: string
  readonly indexPath: string
}): Promise<IndexReconcilePlan> {
  const vaultRoot = resolve(options.vaultRoot)
  const indexPath = resolve(options.indexPath)
  const catalog = await catalogSyncedDocuments(vaultRoot)
  const ReadOnlyDatabase = Database as unknown as new (
    filename: string,
    options: { readonly: boolean; fileMustExist: boolean },
  ) => Database
  const db = new ReadOnlyDatabase(indexPath, { readonly: true, fileMustExist: true })
  const findings: IndexReconcileFinding[] = []
  try {
    const courses = db
      .prepare("SELECT canvas_id, workflow_state, vault_path FROM courses")
      .all() as IndexedRow[]
    const concluded = new Set(
      courses
        .filter((row) => row.workflow_state === "completed" || row.workflow_state === "concluded")
        .map((row) => row.canvas_id),
    )
    for (const row of courses) {
      await considerRow("courses", row, row.canvas_id)
    }
    for (const table of documentTables) {
      const sql =
        table === "assignments"
          ? "SELECT canvas_id, course_canvas_id, vault_path, deleted FROM assignments"
          : `SELECT canvas_id, course_canvas_id, vault_path FROM ${table}`
      for (const row of db.prepare(sql).all() as IndexedRow[]) {
        await considerRow(table, row, row.course_canvas_id ?? "")
      }
    }

    async function considerRow(table: IndexedTable, row: IndexedRow, courseCanvasId: string) {
      if (!row.vault_path) return // Null paths can intentionally represent unavailable downloads.
      const indexedPath = isAbsolute(row.vault_path)
        ? resolve(row.vault_path)
        : resolve(vaultRoot, row.vault_path)
      if (within(vaultRoot, indexedPath) && (await exists(indexedPath))) return
      const candidates = catalog.get(key(courseCanvasId, table, row.canvas_id)) ?? []
      const unavailable = row.deleted === 1 || concluded.has(courseCanvasId)
      const courseRootExists = await exists(coursePaths(vaultRoot, "", courseCanvasId).root)
      const status: ReconcileStatus = unavailable
        ? "concluded-or-deleted"
        : candidates.length > 1
          ? "ambiguous-relocation"
          : candidates.length === 1
            ? "unique-relocation"
            : !courseRootExists
              ? "course-root-absent"
              : "missing-local"
      findings.push({
        table,
        canvasId: row.canvas_id,
        courseCanvasId,
        indexedPath,
        indexedPathScope: within(vaultRoot, indexedPath) ? "inside-vault" : "outside-vault",
        status,
        candidates,
        note:
          status === "unique-relocation"
            ? "One matching sync-owned vault document exists in the same Canvas course; review before relinking."
            : status === "ambiguous-relocation"
              ? "Multiple matching documents exist; no path can be selected safely."
              : status === "concluded-or-deleted"
                ? "The indexed course is concluded or the assignment is deleted; local absence may be expected."
                : status === "course-root-absent"
                  ? "The entire course root is absent locally; check the course allowlist and historical sync state."
                  : "No matching local document was found; Canvas availability has not been checked.",
      })
    }
  } finally {
    db.close()
  }
  findings.sort((a, b) =>
    `${a.table}/${a.courseCanvasId}/${a.canvasId}`.localeCompare(
      `${b.table}/${b.courseCanvasId}/${b.canvasId}`,
    ),
  )
  return {
    vaultRoot,
    indexPath,
    findings,
    proposedRelinks: findings.filter((finding) => finding.status === "unique-relocation").length,
    dryRun: true,
  }
}

async function catalogSyncedDocuments(vaultRoot: string): Promise<Map<string, string[]>> {
  const catalog = new Map<string, string[]>()
  for (const entry of await readdir(vaultRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue
    const courseRoot = join(vaultRoot, entry.name)
    const manifestPath = join(courseRoot, vaultLayout.index)
    let courseId: string
    try {
      const manifestStat = await lstat(manifestPath)
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) continue
      const manifest = parseVaultDocument(await readFile(manifestPath, "utf8"), manifestPath)
      courseId = manifest.frontmatter.canvas_id
      const urlId = /(?:^|\/)courses\/([^/]+)/.exec(
        new URL(manifest.frontmatter.canvas_url).pathname,
      )?.[1]
      if (
        manifest.frontmatter.type !== "index" ||
        urlId !== courseId ||
        courseRoot !== coursePaths(vaultRoot, "", courseId).root
      ) {
        continue
      }
    } catch {
      continue // Unindexed/user-owned roots cannot establish Canvas ownership.
    }
    add(key(courseId, "courses", courseId), courseRoot)
    await walk(courseRoot, async (path) => {
      if (path === manifestPath || !path.endsWith(".md")) return
      try {
        const document = parseVaultDocument(await readFile(path, "utf8"), path)
        if (document.frontmatter.source !== "sync") return
        for (const table of documentTables) {
          if (document.frontmatter.type === vaultLayout[table]) {
            add(key(courseId, table, document.frontmatter.canvas_id), path)
          }
        }
      } catch {
        // A non-School-Agent/user document is never a relocation candidate.
      }
    })
  }
  return catalog

  function add(identity: string, path: string) {
    const matches = catalog.get(identity) ?? []
    matches.push(path)
    catalog.set(identity, matches)
  }
}

async function walk(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "_meta") continue
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) await walk(path, visit)
    else if (entry.isFile()) await visit(path)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return !(await lstat(path)).isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

function key(courseId: string, table: IndexedTable, canvasId: string): string {
  return JSON.stringify([courseId, table, canvasId])
}
