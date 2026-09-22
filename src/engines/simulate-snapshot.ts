import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { SchoolConfig } from "../config/index.js"
import { coursePaths, slugify, vaultLayout } from "../store/paths.js"
import { parseVaultDocument, renderVaultDocument } from "../store/vault.js"
import type { PrepCourse } from "./prep.js"
import { SimulationError } from "./simulate.js"
import {
  computeVisibility,
  courseSetupCutoff,
  type ModuleDatesById,
  type VisibilitySignal,
} from "./simulate-visibility.js"

export type SnapshotDocument = {
  readonly path: string
  readonly relativePath: string
  readonly raw: string
  readonly visibleAt: string | null
  readonly visibilitySignal: VisibilitySignal
}

export type PilotSnapshot = {
  readonly course: PrepCourse
  readonly root: string
  readonly indexRaw: string
  readonly documents: readonly SnapshotDocument[]
}

export async function pilotSnapshot(config: SchoolConfig): Promise<PilotSnapshot> {
  if (config.courses.pilotCourseId === null) {
    throw new SimulationError("No pilot course configured. Set courses.pilotCourseId first.")
  }
  for (const entry of await readdir(config.vault.path, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue
    const root = join(config.vault.path, entry.name)
    const indexPath = join(root, vaultLayout.index)
    try {
      const indexRaw = await readFile(indexPath, "utf8")
      const index = parseVaultDocument(indexRaw, indexPath)
      if (index.frontmatter.canvas_id !== config.courses.pilotCourseId) continue
      return {
        course: {
          code: entry.name,
          canvasId: index.frontmatter.canvas_id,
          canvasUrl: index.frontmatter.canvas_url,
          aiPolicy: index.frontmatter.ai_policy,
        },
        root,
        indexRaw,
        documents: await snapshotDocuments(root, indexPath),
      }
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      throw error
    }
  }
  throw new SimulationError(`Pilot course snapshot not found: ${config.courses.pilotCourseId}`)
}

export function visibleDocuments(
  documents: readonly SnapshotDocument[],
  asOf: string,
): readonly SnapshotDocument[] {
  return documents.filter((document) => document.visibleAt !== null && document.visibleAt <= asOf)
}

/** Per-signal breakdown of every document's visibility rule (see simulate-visibility.ts), for report.json / the M1 bundle. */
export function visibilityBySignal(
  documents: readonly SnapshotDocument[],
): Readonly<Record<VisibilitySignal, number>> {
  const counts: Record<VisibilitySignal, number> = {
    unlock_at: 0,
    posted_at: 0,
    module_release: 0,
    due_at: 0,
    created_at: 0,
    unknown: 0,
  }
  for (const document of documents) counts[document.visibilitySignal] += 1
  return counts
}

export async function stageSnapshot(
  snapshot: PilotSnapshot,
  documents: readonly SnapshotDocument[],
  destination: string,
): Promise<void> {
  const paths = coursePaths(destination, snapshot.course.code, snapshot.course.canvasId)
  await mkdir(paths.root, { recursive: true })
  // Guidance files carry no date signal (they are agent steering, not
  // date-released course content), so they are never in the visible set. Stage
  // them unconditionally so the replay's guidance-driven structure/instructions
  // stay available; guidance has no future date, so this never leaks.
  const staged = new Map<string, SnapshotDocument>()
  for (const document of documents) staged.set(document.relativePath, document)
  for (const document of snapshot.documents) {
    if (document.relativePath.startsWith("guidance/")) {
      staged.set(document.relativePath, document)
    }
  }
  const allowed = new Set(staged.keys())
  const index = parseVaultDocument(snapshot.indexRaw, join(snapshot.root, vaultLayout.index))
  await writeFile(
    paths.index,
    renderVaultDocument(index.frontmatter, filteredManifest(index.content, allowed)),
    "utf8",
  )
  await Promise.all(
    [...staged.values()].map(async (document) => {
      const path = join(paths.root, document.relativePath)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, document.raw, "utf8")
    }),
  )
}

export function assignmentDocuments(
  documents: readonly SnapshotDocument[],
): readonly SnapshotDocument[] {
  return documents.filter((document) => document.relativePath.startsWith("assignments/"))
}

/**
 * Narrow the assignments a simulation drafts to the ones a single module
 * references. A module document lists its assignment items as `- Assignment:
 * <title>` (see renderModuleItem in sync-render.ts). The referenced title is
 * slugified and resolved back to the `assignments/<slug>.md` document path that
 * sync writes (courseDocumentPath uses the same slugify), so an assignment
 * belongs to a module when its path matches one of the module's references.
 *
 * The module document itself may carry no date signal (dates: {}), so it is
 * looked up across the ENTIRE snapshot, not just the visible set, while the
 * returned assignments are drawn from `visible` so the as-of clock and leakage
 * contract stay intact — an assignment the module references but that is not
 * yet visible is simply not drafted.
 */
export function moduleAssignmentDocuments(
  snapshot: PilotSnapshot,
  visible: readonly SnapshotDocument[],
  moduleCanvasId: string,
): readonly SnapshotDocument[] {
  const moduleDocument = snapshot.documents.find(
    (document) =>
      document.relativePath.startsWith("modules/") &&
      parseVaultDocument(document.raw, document.path).frontmatter.canvas_id === moduleCanvasId,
  )
  if (moduleDocument === undefined) {
    throw new SimulationError(`Module ${moduleCanvasId} not found in the pilot course snapshot.`)
  }
  const content = parseVaultDocument(moduleDocument.raw, moduleDocument.path).content
  // Matches both the current `- Assignment: <title> (canvas_id: <id>)` line
  // and the older title-only form (vaults synced before that enrichment).
  const assignmentLine = /^- Assignment:\s*(.+?)(?:\s*\(canvas_id:\s*(\S+)\))?\s*$/gm
  const byCanvasId = new Map<string, string>()
  for (const document of visible) {
    if (!document.relativePath.startsWith("assignments/")) continue
    const id = parseVaultDocument(document.raw, document.path).frontmatter.canvas_id
    byCanvasId.set(id, document.relativePath)
  }
  const referencedPaths = new Set(
    [...content.matchAll(assignmentLine)].flatMap((match) => {
      const title = match[1]?.trim() ?? ""
      const canvasId = match[2]
      if (canvasId !== undefined) {
        const byId = byCanvasId.get(canvasId)
        if (byId !== undefined) return [byId]
      }
      return title.length === 0 ? [] : [`assignments/${slugify(title, "untitled")}.md`]
    }),
  )
  return visible.filter((document) => referencedPaths.has(document.relativePath))
}

async function snapshotDocuments(
  root: string,
  indexPath: string,
): Promise<readonly SnapshotDocument[]> {
  const entries = await readdir(root, { recursive: true })
  const paths = entries.filter((entry) => entry.endsWith(".md")).sort()
  const files = await Promise.all(
    paths
      .filter((entry) => join(root, entry) !== indexPath)
      .map(async (entry) => {
        const path = join(root, entry)
        const raw = await readFile(path, "utf8")
        return { path, relativePath: entry, raw, parsed: parseVaultDocument(raw, path) }
      }),
  )

  const moduleDatesById: ModuleDatesById = new Map(
    files
      .filter((file) => file.relativePath.startsWith(`${vaultLayout.modules}/`))
      .map((file) => [file.parsed.frontmatter.canvas_id, file.parsed.frontmatter.dates]),
  )
  const assignmentDueAts = files
    .filter((file) => file.relativePath.startsWith(`${vaultLayout.assignments}/`))
    .map((file) => file.parsed.frontmatter.dates["due_at"])
  const cutoff = courseSetupCutoff(moduleDatesById, assignmentDueAts)

  return files.map((file) => {
    const visibility = computeVisibility(
      file.parsed.frontmatter.dates,
      file.parsed.frontmatter.module_canvas_id,
      moduleDatesById,
      cutoff,
    )
    return {
      path: file.path,
      relativePath: file.relativePath,
      raw: file.raw,
      visibleAt: visibility.visibleAt,
      visibilitySignal: visibility.signal,
    }
  })
}

function filteredManifest(content: string, allowed: ReadonlySet<string>): string {
  return content
    .split("\n")
    .filter((line, index) => {
      if (index < 2 || !line.startsWith("|")) return true
      const cells = line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
      const path = cells[3]
      return path === undefined || path === "Path" || path.startsWith("-") || allowed.has(path)
    })
    .join("\n")
}
