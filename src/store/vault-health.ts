import { readdir, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import Database from "better-sqlite3"

import { vaultLayout } from "./paths.js"

export type VaultHealthIssueKind =
  | "duplicate-week-directory"
  | "stale-indexed-path"
  | "missing-indexed-file"
  | "unexpected-course-root"

export type VaultHealthIssue = {
  readonly kind: VaultHealthIssueKind
  readonly path: string
  readonly detail: string
}

export type VaultHealthRepairAction = {
  readonly kind: "review-duplicate-week" | "refresh-index-path" | "review-course-root"
  readonly path: string
  readonly detail: string
  readonly automatic: false
}

export type VaultHealthPlan = {
  readonly root: string
  readonly indexPath: string
  readonly issues: readonly VaultHealthIssue[]
  readonly repairPlan: readonly VaultHealthRepairAction[]
  readonly dryRun: true
}

/** Read-only integrity audit. The returned repair plan is advisory and never mutates either input. */
export async function planVaultHealth(options: {
  readonly root: string
  readonly indexPath: string
}): Promise<VaultHealthPlan> {
  const root = resolve(options.root)
  const indexPath = resolve(options.indexPath)
  const ReadOnlyDatabase = Database as unknown as new (
    filename: string,
    options: { readonly: boolean; fileMustExist: boolean },
  ) => Database
  const db = new ReadOnlyDatabase(indexPath, { readonly: true, fileMustExist: true })
  const issues: VaultHealthIssue[] = []
  try {
    const indexedRows: { table: string; path: string }[] = []
    const courseRows = db.prepare("SELECT canvas_id, vault_path FROM courses").all() as {
      canvas_id: string
      vault_path: string | null
    }[]
    const expectedRoots = new Set<string>()
    for (const course of courseRows) {
      if (course.vault_path) {
        const courseRoot = isAbsolute(course.vault_path)
          ? resolve(course.vault_path)
          : resolve(root, course.vault_path)
        expectedRoots.add(courseRoot)
        if (!isWithin(root, courseRoot))
          issues.push({
            kind: "stale-indexed-path",
            path: courseRoot,
            detail: `courses row for Canvas ID ${course.canvas_id} points outside the supplied vault root.`,
          })
        else if (!(await pathExists(courseRoot)))
          issues.push({
            kind: "stale-indexed-path",
            path: courseRoot,
            detail: `courses row for Canvas ID ${course.canvas_id} points to a missing course root.`,
          })
      } else
        issues.push({
          kind: "stale-indexed-path",
          path: `course:${course.canvas_id}`,
          detail: "Course has no indexed vault path.",
        })
    }
    for (const table of ["modules", "assignments", "announcements", "files"] as const) {
      const rows = db
        .prepare(`SELECT vault_path FROM ${table} WHERE vault_path IS NOT NULL`)
        .all() as { vault_path: string }[]
      for (const row of rows) indexedRows.push({ table, path: row.vault_path })
    }
    for (const row of indexedRows) {
      const indexedPath = isAbsolute(row.path) ? resolve(row.path) : resolve(root, row.path)
      if (!isWithin(root, indexedPath)) {
        issues.push({
          kind: "stale-indexed-path",
          path: indexedPath,
          detail: `${row.table} row points outside the supplied vault root.`,
        })
        continue
      }
      if (!(await pathExists(indexedPath))) {
        const kind = row.table === "files" ? "missing-indexed-file" : "stale-indexed-path"
        issues.push({
          kind,
          path: indexedPath,
          detail: `${row.table} row points to a path that does not exist.`,
        })
      }
    }

    const rootEntries = await readdir(root, { withFileTypes: true })
    const courseDirs = rootEntries.filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."),
    )
    for (const entry of courseDirs) {
      const courseRoot = join(root, entry.name)
      const childEntries = await readdir(courseRoot, { withFileTypes: true })
      const weeks = new Map<string, string[]>()
      for (const child of childEntries) {
        if (!child.isDirectory()) continue
        const match = /^Week\s+(\d+)(?:\b|\s*-)/i.exec(child.name)
        if (!match) continue
        const number = String(Number(match[1]))
        const names = weeks.get(number) ?? []
        names.push(child.name)
        weeks.set(number, names)
      }
      for (const [number, names] of weeks) {
        if (names.length > 1)
          issues.push({
            kind: "duplicate-week-directory",
            path: courseRoot,
            detail: `Week ${number} appears in multiple directories: ${names.join(", ")}.`,
          })
      }
      const courseIndex = join(courseRoot, vaultLayout.index)
      if ((await pathExists(courseIndex)) && !expectedRoots.has(resolve(courseRoot))) {
        issues.push({
          kind: "unexpected-course-root",
          path: courseRoot,
          detail: "Course root has a manifest but is not referenced by the SQLite courses table.",
        })
      }
    }
  } finally {
    db.close()
  }
  const repairPlan = issues.map(
    (issue): VaultHealthRepairAction => ({
      kind:
        issue.kind === "duplicate-week-directory"
          ? "review-duplicate-week"
          : issue.kind === "unexpected-course-root"
            ? "review-course-root"
            : "refresh-index-path",
      path: issue.path,
      detail: `Review ${issue.detail}`,
      automatic: false,
    }),
  )
  return { root, indexPath, issues, repairPlan, dryRun: true }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  )
}
