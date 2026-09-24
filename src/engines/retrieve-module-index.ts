import { readdir, readFile } from "node:fs/promises"
import { basename, join, relative, sep } from "node:path"

import { slugify, vaultDocumentKinds, vaultLayout } from "../store/paths.js"
import { parseVaultDocument } from "../store/vault.js"
import { isEnoent } from "../util/errors.js"

/**
 * Resolves a module item's `title`/`canvas_id` back to the vault-relative
 * path (and, for assignments, the `due_at`) sync wrote for it.
 *
 * V1 stored each artifact under a fixed lower-case directory. V2 groups
 * artifacts under dated Week/Milestone and assignment directories instead,
 * so this index deliberately discovers parsed documents recursively and uses
 * frontmatter identity first, with path classification only as a v1/plain
 * fixture fallback.
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
  const documents = await parsedMarkdownFiles(courseRoot)
  const assignments = documents.filter((document) =>
    isKind(document, vaultDocumentKinds.assignment),
  )
  const files = documents.filter((document) => isKind(document, vaultDocumentKinds.file))
  const modules = documents.filter((document) => isKind(document, vaultDocumentKinds.module))
  return {
    assignmentsByCanvasId: assignmentCanvasIdIndex(courseRoot, assignments),
    assignmentsBySlug: assignmentSlugIndex(courseRoot, assignments),
    filesByCanvasId: canvasIdIndex(courseRoot, files),
    filesBySlug: slugIndex(courseRoot, files),
    moduleFilesBySlug: slugIndex(courseRoot, modules),
  }
}

function canvasIdIndex(
  courseRoot: string,
  documents: readonly ParsedMarkdownFile[],
): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const document of documents) {
    index.set(document.parsed.frontmatter.canvas_id, relativePath(courseRoot, document.path))
  }
  return index
}

function assignmentCanvasIdIndex(
  courseRoot: string,
  documents: readonly ParsedMarkdownFile[],
): ReadonlyMap<string, AssignmentEntry> {
  const index = new Map<string, AssignmentEntry>()
  for (const document of documents) {
    index.set(document.parsed.frontmatter.canvas_id, {
      path: relativePath(courseRoot, document.path),
      dueAt: document.parsed.frontmatter.dates["due_at"] ?? null,
    })
  }
  return index
}

function assignmentSlugIndex(
  courseRoot: string,
  documents: readonly ParsedMarkdownFile[],
): ReadonlyMap<string, AssignmentEntry> {
  const index = new Map<string, AssignmentEntry>()
  for (const document of documents) {
    const path = relativePath(courseRoot, document.path)
    const entry = {
      path,
      dueAt: document.parsed.frontmatter.dates["due_at"] ?? null,
    }
    for (const slug of pathSlugs(path, "assignment")) {
      if (!index.has(slug)) index.set(slug, entry)
    }
  }
  return index
}

function slugIndex(
  courseRoot: string,
  documents: readonly ParsedMarkdownFile[],
): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const document of documents) {
    const path = relativePath(courseRoot, document.path)
    for (const slug of pathSlugs(path)) {
      if (!index.has(slug)) index.set(slug, path)
    }
  }
  return index
}

/**
 * Reverse membership index: module Canvas ID -> every document carrying that
 * `module_canvas_id`. Scanning the complete course tree is necessary for v2,
 * where a linked artifact may live under a Week's Materials or an assignment
 * subtree instead of under a fixed lower-case directory.
 */
export async function buildModuleMembership(
  courseRoot: string,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const membership = new Map<string, string[]>()
  for (const document of await parsedMarkdownFiles(courseRoot)) {
    const moduleCanvasId = document.parsed.frontmatter.module_canvas_id
    if (moduleCanvasId === undefined) continue
    const rel = relativePath(courseRoot, document.path)
    const existing = membership.get(moduleCanvasId)
    if (existing === undefined) {
      membership.set(moduleCanvasId, [rel])
    } else {
      existing.push(rel)
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

type ParsedMarkdownFile = {
  readonly path: string
  readonly relativePath: string
  readonly parsed: ReturnType<typeof parseVaultDocument>
}

async function parsedMarkdownFiles(courseRoot: string): Promise<readonly ParsedMarkdownFile[]> {
  const documents: ParsedMarkdownFile[] = []
  for (const file of await listMarkdownFiles(courseRoot)) {
    try {
      documents.push({
        path: file,
        relativePath: relativePath(courseRoot, file),
        parsed: parseVaultDocument(await readFile(file, "utf8"), file),
      })
    } catch {
      // Plain user notes are not Canvas artifacts. They remain in the vault,
      // but do not participate in module resolution.
    }
  }
  return documents
}

function isKind(document: ParsedMarkdownFile, kind: string): boolean {
  if (document.parsed.frontmatter.type === kind) return true
  const parts = document.relativePath.split("/")
  const first = parts[0] ?? ""
  if (kind === vaultDocumentKinds.module) {
    return first === vaultLayout.modules || /^(?:Week|Milestone)\s+\d+/i.test(first)
  }
  if (kind === vaultDocumentKinds.assignment) {
    return first === vaultLayout.assignments || first === vaultLayout.assignmentsDirectory
  }
  if (kind === vaultDocumentKinds.file) {
    return (
      first === vaultLayout.files ||
      first === vaultLayout.filesDirectory ||
      (first === vaultLayout.resources && parts[1] === vaultLayout.filesDirectory)
    )
  }
  return false
}

function relativePath(courseRoot: string, path: string): string {
  return relative(courseRoot, path).split(sep).join("/")
}

function pathSlugs(path: string, kind?: "assignment"): readonly string[] {
  const parts = path.split("/")
  const candidates = new Set<string>()
  addSlug(candidates, basename(path).replace(/\.md$/i, ""))
  if (kind === "assignment") {
    const assignmentRootIndex = parts.findIndex(
      (part) => part === vaultLayout.assignmentsDirectory || part === vaultLayout.assignments,
    )
    const root = assignmentRootIndex < 0 ? undefined : parts[assignmentRootIndex + 1]
    if (root !== undefined) {
      addSlug(candidates, root.replace(/^\d{4}-\d{2}-\d{2}\s+-\s+/, ""))
      addSlug(candidates, root.replace(/^Undated\s+-\s+/i, ""))
      addSlug(candidates, root.replace(/^Assignment\s+-\s+/i, ""))
    }
  }
  return [...candidates]
}

function addSlug(target: Set<string>, value: string): void {
  const slug = slugify(value, "")
  if (slug.length > 0 && !/^\d+$/.test(slug)) target.add(slug)
}
