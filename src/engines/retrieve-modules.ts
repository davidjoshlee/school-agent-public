import { readFile } from "node:fs/promises"
import { relative, sep } from "node:path"

import { slugify, vaultDocumentKinds, vaultLayout } from "../store/paths.js"
import { parseVaultDocument } from "../store/vault.js"
import { buildPathIndex, listMarkdownFiles, type PathIndex } from "./retrieve-module-index.js"

/**
 * Module-structured retrieval, the replacement for keyword scoring over the
 * flat manifest (see ENGINEERING-LOG / the retrieval CTO review). Canvas
 * modules already encode "what belongs to this session"; this file loads
 * that structure back out of the synced vault (never the SQLite index —
 * simulate() runs against a staged vault copy with an empty in-memory index)
 * and resolves each module-item line to the vault-relative path sync wrote
 * for it. Resolution is always best-effort: an item that cannot be resolved
 * is returned with `resolvedPath: undefined`, never thrown.
 */

export type ModuleItem = {
  readonly type: string
  readonly title: string
  readonly canvasId?: string
  readonly resolvedPath?: string
  /** The referenced assignment's own due_at, when the item resolves to an assignments/*.md doc. Lets a week period match a module by "an assignment it references is due this week" even when the module itself carries no unlock_at/session_at. */
  readonly dueAt?: string | null
}

export type CourseModule = {
  readonly canvasId: string
  readonly title: string
  readonly position: number
  readonly dates: Readonly<Record<string, string | null>>
  readonly items: readonly ModuleItem[]
  /** The module root document's own vault-relative path, so a module selection can include the module's own content (session notes, overview) alongside its items — not just the items it references. */
  readonly path: string
}

// `- <Type>: <Title> (canvas_id: <id>|page_url: <url>)`, rendered by
// renderModuleItem in sync-render.ts. The suffix is optional so a module
// synced before that enrichment (title-only lines) still parses.
const itemLine = /^- ([A-Za-z]+):\s*(.+?)(?:\s*\((canvas_id|page_url):\s*(\S+)\))?\s*$/

export async function loadCourseModules(courseRoot: string): Promise<readonly CourseModule[]> {
  const files = await listMarkdownFiles(courseRoot)
  const index = await buildPathIndex(courseRoot)
  const modules: CourseModule[] = []
  for (const file of files) {
    const raw = await readFile(file, "utf8")
    let parsed: ReturnType<typeof parseVaultDocument>
    try {
      parsed = parseVaultDocument(raw, file)
    } catch {
      continue
    }
    if (!looksLikeModuleDocument(courseRoot, file, parsed.frontmatter.type)) continue
    const root = parseModuleRoot(parsed.content)
    if (root === null) continue
    modules.push({
      canvasId: parsed.frontmatter.canvas_id,
      title: root.title,
      position: positionFromDirectory(courseRoot, file),
      dates: parsed.frontmatter.dates,
      items: root.items.map((item) => resolveItem(item, index)),
      path: relative(courseRoot, file),
    })
  }
  return modules.sort((left, right) => left.position - right.position)
}

type RawModuleItem = { readonly type: string; readonly title: string; readonly canvasId?: string }

/**
 * A module-root document's body is exactly `renderModule`'s shape: a title
 * line, then only `- Type: Title (...)` lines. Any other shape (a Page body,
 * a discussion message, …) fails to parse and is treated as "not a module
 * root" rather than thrown — module item docs living in the same `modules/`
 * tree are common and are simply skipped here.
 */
function parseModuleRoot(
  content: string,
): { readonly title: string; readonly items: readonly RawModuleItem[] } | null {
  const lines = content.split("\n")
  const title = lines[0]?.trim()
  if (title === undefined || title.length === 0) return null
  const rest = lines
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const items: RawModuleItem[] = []
  for (const line of rest) {
    const match = itemLine.exec(line)
    if (match === null) return null
    const [, type, itemTitle, kind, value] = match
    if (type === undefined || itemTitle === undefined) return null
    items.push({
      type,
      title: itemTitle,
      ...(kind === "canvas_id" && value !== undefined ? { canvasId: value } : {}),
    })
  }
  return { title, items }
}

function positionFromDirectory(courseRoot: string, file: string): number {
  const rel = relative(courseRoot, file).split(sep).join("/")
  const v1Match = /(?:^|\/)(\d+)-/.exec(rel)
  if (v1Match?.[1] !== undefined) return Number.parseInt(v1Match[1], 10)
  const v2Match = /(?:^|\/)(?:Week|Milestone)\s+(\d+)(?:\s+-|\/)/i.exec(rel)
  return v2Match?.[1] === undefined ? 0 : Number.parseInt(v2Match[1], 10)
}

function looksLikeModuleDocument(courseRoot: string, file: string, type: string): boolean {
  if (type === vaultDocumentKinds.module) return true
  const rel = relative(courseRoot, file).split(sep).join("/")
  const first = rel.split("/")[0] ?? ""
  return first === vaultLayout.modules || /^(?:Week|Milestone)\s+\d+/i.test(first)
}

function resolveItem(item: RawModuleItem, index: PathIndex): ModuleItem {
  if (item.type === "Assignment") {
    const slug = slugify(item.title, "")
    const entry =
      (item.canvasId === undefined ? undefined : index.assignmentsByCanvasId.get(item.canvasId)) ??
      index.assignmentsBySlug.get(slug)
    return {
      type: item.type,
      title: item.title,
      ...(item.canvasId === undefined ? {} : { canvasId: item.canvasId }),
      ...(entry === undefined ? {} : { resolvedPath: entry.path }),
      ...(entry?.dueAt === undefined || entry.dueAt === null ? {} : { dueAt: entry.dueAt }),
    }
  }
  const resolvedPath = resolvePath(item, index)
  return {
    type: item.type,
    title: item.title,
    ...(item.canvasId === undefined ? {} : { canvasId: item.canvasId }),
    ...(resolvedPath === undefined ? {} : { resolvedPath }),
  }
}

function resolvePath(item: RawModuleItem, index: PathIndex): string | undefined {
  const slug = slugify(item.title, "")
  switch (item.type) {
    case "File":
      return (
        (item.canvasId === undefined ? undefined : index.filesByCanvasId.get(item.canvasId)) ??
        index.filesBySlug.get(slug)
      )
    default:
      return (
        index.moduleFilesBySlug.get(slug) ??
        index.moduleFilesBySlug.get(`discussion-${slug}`) ??
        index.moduleFilesBySlug.get(`quiz-${slug}`)
      )
  }
}
