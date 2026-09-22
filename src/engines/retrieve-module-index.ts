import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

import { vaultLayout } from "../store/paths.js"
import { parseVaultDocument } from "../store/vault.js"
import { isEnoent } from "../util/errors.js"

/**
 * Resolves a module item's `title`/`canvas_id` back to the vault-relative
 * path (and, for assignments, the `due_at`) sync wrote for it — the lookup
 * tables `retrieve-modules.ts`'s `resolveItem` needs, split out to keep that
 * file under the 250-LOC ceiling.
 */

export type AssignmentEntry = { readonly path: string; readonly dueAt: string | null }

export type PathIndex = {
  readonly assignmentsByCanvasId: ReadonlyMap<string, AssignmentEntry>
  readonly assignmentsBySlug: ReadonlyMap<string, AssignmentEntry>
  readonly filesByCanvasId: ReadonlyMap<string, string>
  readonly filesBySlug: ReadonlyMap<string, string>
  readonly moduleFilesBySlug: ReadonlyMap<string, string>
}

export async function buildPathIndex(courseRoot: string): Promise<PathIndex> {
  const assignmentsDir = join(courseRoot, vaultLayout.assignments)
  const filesDir = join(courseRoot, vaultLayout.files)
  const [
    assignmentsByCanvasId,
    assignmentsBySlug,
    filesByCanvasId,
    filesBySlug,
    moduleFilesBySlug,
  ] = await Promise.all([
    assignmentCanvasIdIndex(courseRoot, assignmentsDir),
    assignmentSlugIndex(courseRoot, assignmentsDir),
    canvasIdIndex(courseRoot, filesDir),
    slugIndex(courseRoot, filesDir),
    slugIndex(courseRoot, join(courseRoot, vaultLayout.modules)),
  ])
  return {
    assignmentsByCanvasId,
    assignmentsBySlug,
    filesByCanvasId,
    filesBySlug,
    moduleFilesBySlug,
  }
}

async function canvasIdIndex(
  courseRoot: string,
  directory: string,
): Promise<ReadonlyMap<string, string>> {
  const index = new Map<string, string>()
  for (const file of await listMarkdownFiles(directory)) {
    try {
      const parsed = parseVaultDocument(await readFile(file, "utf8"), file)
      index.set(parsed.frontmatter.canvas_id, relative(courseRoot, file))
    } catch {}
  }
  return index
}

async function assignmentCanvasIdIndex(
  courseRoot: string,
  directory: string,
): Promise<ReadonlyMap<string, AssignmentEntry>> {
  const index = new Map<string, AssignmentEntry>()
  for (const file of await listMarkdownFiles(directory)) {
    try {
      const parsed = parseVaultDocument(await readFile(file, "utf8"), file)
      index.set(parsed.frontmatter.canvas_id, {
        path: relative(courseRoot, file),
        dueAt: parsed.frontmatter.dates["due_at"] ?? null,
      })
    } catch {}
  }
  return index
}

async function assignmentSlugIndex(
  courseRoot: string,
  directory: string,
): Promise<ReadonlyMap<string, AssignmentEntry>> {
  const index = new Map<string, AssignmentEntry>()
  for (const file of await listMarkdownFiles(directory)) {
    const base = file.split("/").at(-1)?.replace(/\.md$/, "")
    if (base === undefined) continue
    try {
      const parsed = parseVaultDocument(await readFile(file, "utf8"), file)
      index.set(base, {
        path: relative(courseRoot, file),
        dueAt: parsed.frontmatter.dates["due_at"] ?? null,
      })
    } catch {
      index.set(base, { path: relative(courseRoot, file), dueAt: null })
    }
  }
  return index
}

async function slugIndex(
  courseRoot: string,
  directory: string,
): Promise<ReadonlyMap<string, string>> {
  const index = new Map<string, string>()
  for (const file of await listMarkdownFiles(directory)) {
    const base = file.split("/").at(-1)?.replace(/\.md$/, "")
    if (base !== undefined) index.set(base, relative(courseRoot, file))
  }
  return index
}

/**
 * Reverse membership index: module canvas id -> vault-relative paths of every
 * doc under assignments/, files/, and modules/ whose frontmatter carries that
 * `module_canvas_id`. This is the durable link `simulate-visibility.ts`
 * already trusts for visibility; module retrieval uses it the same way so a
 * doc reaches a selected module's context regardless of whether it also
 * appears in the module root doc's item list (e.g. a manually `ingest
 * --module`-tagged file, never listed there).
 */
export async function buildModuleMembership(
  courseRoot: string,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const directories = [vaultLayout.assignments, vaultLayout.files, vaultLayout.modules].map((dir) =>
    join(courseRoot, dir),
  )
  const membership = new Map<string, string[]>()
  for (const directory of directories) {
    for (const file of await listMarkdownFiles(directory)) {
      try {
        const parsed = parseVaultDocument(await readFile(file, "utf8"), file)
        const moduleCanvasId = parsed.frontmatter.module_canvas_id
        if (moduleCanvasId === undefined) continue
        const rel = relative(courseRoot, file)
        const existing = membership.get(moduleCanvasId)
        if (existing === undefined) {
          membership.set(moduleCanvasId, [rel])
        } else {
          existing.push(rel)
        }
      } catch {}
    }
  }
  return membership
}

export async function listMarkdownFiles(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { recursive: true })
    return entries
      .filter((entry) => entry.endsWith(".md") && !entry.endsWith(".summary.md"))
      .sort()
      .map((entry) => join(root, entry))
  } catch (error: unknown) {
    if (isEnoent(error)) return []
    throw error
  }
}
