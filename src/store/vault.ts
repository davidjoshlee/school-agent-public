import type { Dirent } from "node:fs"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join, relative, sep } from "node:path"

import type { SchoolConfig } from "../config/index.js"
import { isEnoent } from "../util/errors.js"
import { buildCourseManifest } from "./manifest.js"
import type { AssignmentPathRequest, CoursePeriodRequest, VaultDocumentKind } from "./paths.js"
import {
  type CoursePaths,
  canvasUpdatePath,
  courseDocumentPath,
  coursePaths,
  iCloudStubPath,
  vaultDocumentKinds,
  vaultLayout,
  vaultPaths,
  versionedPath,
} from "./paths.js"
import type { VaultFrontmatter, VaultSource, VaultStatus } from "./vault-document.js"
import {
  createVaultFrontmatter,
  parseVaultDocument,
  renderVaultDocument,
  vaultAiPolicies,
  vaultRedistribution,
  vaultSources,
  vaultStatuses,
} from "./vault-document.js"
import { LocalVaultGit, pathExists } from "./vault-local-git.js"

export type {
  ParsedVaultDocument,
  VaultFrontmatter,
  VaultSource,
  VaultStatus,
} from "./vault-document.js"
export {
  parseVaultDocument,
  renderVaultDocument,
  vaultRedistribution,
  vaultSources,
  vaultStatuses,
} from "./vault-document.js"

export type VaultWriteInput = {
  readonly course: {
    readonly code: string
    readonly canvasId: string | number
    readonly canvasUrl: string
    readonly aiPolicy: VaultFrontmatter["ai_policy"]
  }
  readonly kind: VaultDocumentKind
  readonly title: string
  readonly canvasId: string | number
  readonly canvasUrl: string
  readonly content: string
  readonly dates?: Readonly<Record<string, string | null>>
  readonly source: VaultSource
  readonly status: VaultStatus
  readonly redistribution?: VaultFrontmatter["redistribution"]
  readonly model?: string
  readonly module?: {
    readonly number: number
    readonly title: string
    readonly canvasId?: string | number
    readonly kind?: "week" | "milestone"
    readonly date?: string | Date | null
  }
  readonly moduleCanvasId?: string | number
  readonly period?: CoursePeriodRequest
  readonly assignment?: AssignmentPathRequest
  readonly bucket?: "prep" | "materials" | "other"
}
export type VaultWriterConfig = {
  readonly root: string
  readonly gitInit: boolean
  readonly warn?: (message: string) => void
}
export type VaultWriteResult = {
  readonly kind: "written" | "unchanged" | "skipped" | "versioned" | "canvas-update"
  readonly path: string
}
export type CourseManifestWriteInput = {
  readonly course: VaultWriteInput["course"]
  readonly restrictedFileHandling: SchoolConfig["restrictedFileHandling"]
  readonly activeAssignmentIds?: readonly string[]
}
export type SyncLogAppendInput = {
  readonly canvasUrl: string
  readonly entry: string
}
export type VaultMetadataArtifact = "alert"
export type VaultMetadataWriteInput = {
  readonly artifact: VaultMetadataArtifact
  readonly canvasUrl: string
  readonly content: string
}

/** A generated human-navigation page, written after the course artifacts. */
export type VaultNavigationWriteInput = {
  readonly course: VaultWriteInput["course"]
  /** Course-relative path, normally `00 Home.md` or `Week .../00 Overview.md`. */
  readonly path: string
  readonly content: string
}

// allow: SIZE_OK — one atomic vault writer owns layout, ownership, and Git write boundaries.
export class VaultWriter {
  readonly #config: VaultWriterConfig
  readonly #git: LocalVaultGit

  constructor(config: VaultWriterConfig) {
    this.#config = config
    this.#git = new LocalVaultGit(config.root)
  }

  async write(input: VaultWriteInput): Promise<VaultWriteResult> {
    const initialized = await this.initialize()
    const paths = coursePaths(this.#config.root, input.course.code, input.course.canvasId)
    const coursePrepared = await this.prepareCourse(paths, input.course)
    const path = await existingIdentityPath(paths, input)
    const content = renderVaultDocument(
      createVaultFrontmatter({ ...input, type: input.kind, aiPolicy: coursePrepared.aiPolicy }),
      input.content,
    )
    const result = await this.writeOwned(path, input, content)
    if (
      this.#config.gitInit &&
      (initialized || coursePrepared.created || result.kind !== "unchanged")
    ) {
      await this.#git.commit(`write ${basename(result.path)}`)
    }
    return result
  }

  async writeCourseManifest(input: CourseManifestWriteInput): Promise<VaultWriteResult> {
    const initialized = await this.initialize()
    const paths = coursePaths(this.#config.root, input.course.code, input.course.canvasId)
    const coursePrepared = await this.prepareCourse(paths, input.course)
    const content = await buildCourseManifest({
      courseRoot: paths.root,
      indexPath: paths.index,
      restrictedFileHandling: input.restrictedFileHandling,
      ...(input.activeAssignmentIds === undefined
        ? {}
        : { activeAssignmentIds: input.activeAssignmentIds }),
    })
    const result = await writeTarget(
      paths.index,
      renderVaultDocument(
        createVaultFrontmatter({
          canvasId: input.course.canvasId,
          canvasUrl: input.course.canvasUrl,
          type: vaultLayout.index,
          content,
          source: vaultSources.sync,
          status: vaultStatuses.final,
          aiPolicy: coursePrepared.aiPolicy,
          redistribution: vaultRedistribution.allowed,
        }),
        content,
      ),
    )
    if (
      this.#config.gitInit &&
      (initialized || coursePrepared.created || result.kind !== "unchanged")
    ) {
      await this.#git.commit(`write ${basename(result.path)}`)
    }
    return result
  }

  /**
   * Write a generated Home/Overview page through the same ownership and
   * idempotence rules as synchronized artifacts. Navigation paths are
   * intentionally relative to the course root so the v2 path module remains
   * the only place that names the human-facing tree.
   */
  async writeNavigation(input: VaultNavigationWriteInput): Promise<VaultWriteResult> {
    const initialized = await this.initialize()
    const paths = coursePaths(this.#config.root, input.course.code, input.course.canvasId)
    const coursePrepared = await this.prepareCourse(paths, input.course)
    const path = courseNavigationPath(paths, input.path)
    const content = renderVaultDocument(
      createVaultFrontmatter({
        canvasId: `navigation:${input.course.canvasId}:${input.path}`,
        canvasUrl: input.course.canvasUrl,
        type: navigationDocumentType(input.path),
        content: input.content,
        source: vaultSources.sync,
        status: vaultStatuses.final,
        aiPolicy: coursePrepared.aiPolicy,
        redistribution: vaultRedistribution.allowed,
      }),
      input.content,
    )
    const result = await this.writeGenerated(path, content)
    if (
      this.#config.gitInit &&
      (initialized || coursePrepared.created || result.kind !== "unchanged")
    ) {
      await this.#git.commit(`write ${basename(result.path)}`)
    }
    return result
  }

  async appendSyncLog(input: SyncLogAppendInput): Promise<VaultWriteResult> {
    const initialized = await this.initialize()
    const path = vaultPaths(this.#config.root).metadata.syncLog
    const existing = await readOptional(path)
    const previous = existing === null ? "" : parseVaultDocument(existing, path).content.trim()
    const content = [previous, input.entry].filter((value) => value.length > 0).join("\n\n")
    const result = await writeTarget(
      path,
      renderVaultDocument(
        createVaultFrontmatter({
          canvasId: "sync-log",
          canvasUrl: input.canvasUrl,
          type: vaultLayout.syncLog,
          content,
          source: vaultSources.sync,
          status: vaultStatuses.final,
          aiPolicy: vaultAiPolicies.allowed,
          redistribution: vaultRedistribution.allowed,
        }),
        content,
      ),
    )
    if (this.#config.gitInit && (initialized || result.kind !== "unchanged")) {
      await this.#git.commit(`write ${basename(result.path)}`)
    }
    return result
  }

  async writeMetadata(input: VaultMetadataWriteInput): Promise<VaultWriteResult> {
    const initialized = await this.initialize()
    const path = vaultPaths(this.#config.root).metadata[input.artifact]
    if (await pathExists(iCloudStubPath(path))) {
      this.#config.warn?.(`Skipping iCloud placeholder: ${iCloudStubPath(path)}`)
      return { kind: "skipped", path }
    }
    const result = await writeTarget(
      path,
      renderVaultDocument(
        createVaultFrontmatter({
          canvasId: input.artifact,
          canvasUrl: input.canvasUrl,
          type: vaultLayout[input.artifact],
          content: input.content,
          source: vaultSources.sync,
          status: vaultStatuses.final,
          aiPolicy: vaultAiPolicies.allowed,
          redistribution: vaultRedistribution.allowed,
        }),
        input.content,
      ),
    )
    if (this.#config.gitInit && (initialized || result.kind !== "unchanged")) {
      await this.#git.commit(`write ${basename(result.path)}`)
    }
    return result
  }

  private async initialize(): Promise<boolean> {
    const paths = vaultPaths(this.#config.root)
    await mkdir(paths.metadata.directory, { recursive: true })
    const layout = `${JSON.stringify({ layout_version: vaultLayout.version }, null, 2)}\n`
    const changed = await writeIfChanged(paths.metadata.layout, layout)
    if (this.#config.gitInit) {
      await this.#git.initialize()
    }
    return changed
  }

  private async prepareCourse(
    paths: ReturnType<typeof coursePaths>,
    course: VaultWriteInput["course"],
  ): Promise<{ readonly created: boolean; readonly aiPolicy: VaultFrontmatter["ai_policy"] }> {
    await Promise.all(courseDirectories(paths).map((path) => mkdir(path, { recursive: true })))
    const existing = await readOptional(paths.index)
    if (existing !== null) {
      return {
        created: false,
        aiPolicy: parseVaultDocument(existing, paths.index).frontmatter.ai_policy,
      }
    }
    await writeIfChanged(
      paths.index,
      renderVaultDocument(
        createVaultFrontmatter({
          canvasId: course.canvasId,
          canvasUrl: course.canvasUrl,
          type: vaultLayout.index,
          content: "",
          source: vaultSources.agent,
          status: vaultStatuses.final,
          aiPolicy: course.aiPolicy,
          redistribution: vaultRedistribution.allowed,
        }),
        "",
      ),
    )
    return { created: true, aiPolicy: course.aiPolicy }
  }

  private async writeOwned(
    path: string,
    input: VaultWriteInput,
    content: string,
  ): Promise<VaultWriteResult> {
    if (await pathExists(iCloudStubPath(path))) {
      this.#config.warn?.(`Skipping iCloud placeholder: ${iCloudStubPath(path)}`)
      return { kind: "skipped", path }
    }
    const existing = await readOptional(path)
    if (input.kind === vaultDocumentKinds.guidance && existing !== null) {
      return { kind: "unchanged", path }
    }
    if (existing !== null && input.kind === vaultDocumentKinds.draft && isPending(existing, path)) {
      return writeVersion(path, content)
    }
    if (existing !== null && input.source === vaultSources.sync && isUserOwned(existing, path)) {
      return writeUpdate(path, content)
    }
    return writeTarget(path, content)
  }

  private async writeGenerated(path: string, content: string): Promise<VaultWriteResult> {
    if (await pathExists(iCloudStubPath(path))) {
      this.#config.warn?.(`Skipping iCloud placeholder: ${iCloudStubPath(path)}`)
      return { kind: "skipped", path }
    }
    const existing = await readOptional(path)
    if (existing !== null && isUserOwned(existing, path)) {
      return writeUpdate(path, content)
    }
    return writeTarget(path, content)
  }
}

async function existingIdentityPath(paths: CoursePaths, input: VaultWriteInput): Promise<string> {
  const proposed = courseDocumentPath(paths, input)
  if (input.source !== vaultSources.sync) return proposed

  for (const path of await markdownFiles(paths.root)) {
    try {
      const document = parseVaultDocument(await readFile(path, "utf8"), path)
      if (
        document.frontmatter.canvas_id === String(input.canvasId) &&
        document.frontmatter.type === input.kind
      ) {
        if (path === proposed || document.frontmatter.source !== vaultSources.sync) return path
        const proposedDocument = await parsedOptional(proposed)
        if (proposedDocument === null) {
          await mkdir(dirname(proposed), { recursive: true })
          await rename(path, proposed)
          return proposed
        }
        if (
          proposedDocument.frontmatter.canvas_id === String(input.canvasId) &&
          proposedDocument.frontmatter.type === input.kind &&
          proposedDocument.frontmatter.source === vaultSources.sync
        ) {
          await rm(path)
          return proposed
        }
        return path
      }
    } catch {
      // Hand-authored Markdown does not participate in identity resolution.
    }
  }

  // Keep a placeholder at the canonical path authoritative: the normal
  // writer path will skip it and warn rather than silently choosing a sibling.
  if (await pathExists(iCloudStubPath(proposed))) return proposed
  if (!(await pathExists(proposed))) return proposed

  const extension = extname(proposed)
  const stem = proposed.slice(0, proposed.length - extension.length)
  let suffix = 2
  while (await pathExists(`${stem} (${suffix})${extension}`)) suffix += 1
  return `${stem} (${suffix})${extension}`
}

async function parsedOptional(path: string): Promise<ReturnType<typeof parseVaultDocument> | null> {
  const content = await readOptional(path)
  if (content === null) return null
  try {
    return parseVaultDocument(content, path)
  } catch {
    return null
  }
}

async function markdownFiles(directory: string): Promise<readonly string[]> {
  let entries: Dirent[]
  try {
    entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )
  } catch (error: unknown) {
    if (isEnoent(error)) return []
    throw error
  }
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return markdownFiles(path)
      return Promise.resolve(entry.isFile() && entry.name.endsWith(".md") ? [path] : [])
    }),
  )
  return nested.flat()
}

function courseDirectories(paths: ReturnType<typeof coursePaths>): readonly string[] {
  // v2 directories are created by the first artifact that needs them. Keep
  // only the operational playbook parent here; eager course-wide content
  // folders recreate the blank-slate problem and leave empty buckets behind.
  return [dirname(paths.playbook)]
}

function courseNavigationPath(paths: CoursePaths, requested: string): string {
  const normalized = requested.replaceAll("\\", "/").replace(/^\/+/, "")
  const path = join(paths.root, normalized)
  const escaped = relative(paths.root, path)
  if (escaped === ".." || escaped.startsWith(`..${sep}`) || escaped.includes(`${sep}${sep}`)) {
    throw new Error(`Navigation path escapes course root: ${requested}`)
  }
  return path
}

function navigationDocumentType(path: string): string {
  return path.endsWith("00 Home.md") ? vaultLayout.home : vaultLayout.overview
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return null
    }
    throw error
  }
}

async function writeTarget(path: string, content: string): Promise<VaultWriteResult> {
  return { kind: (await writeIfChanged(path, content)) ? "written" : "unchanged", path }
}

async function writeUpdate(path: string, content: string): Promise<VaultWriteResult> {
  const update = canvasUpdatePath(path)
  return {
    kind: (await writeIfChanged(update, content)) ? "canvas-update" : "unchanged",
    path: update,
  }
}

async function writeVersion(path: string, content: string): Promise<VaultWriteResult> {
  const versioned = versionedPath(path, await nextVersion(path))
  return {
    kind: (await writeIfChanged(versioned, content)) ? "versioned" : "unchanged",
    path: versioned,
  }
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  if ((await readOptional(path)) === content) {
    return false
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, "utf8")
  return true
}

function isPending(content: string, path: string): boolean {
  return parseVaultDocument(content, path).frontmatter.status === vaultStatuses.draft
}

function isUserOwned(content: string, path: string): boolean {
  return parseVaultDocument(content, path).frontmatter.source === vaultSources.user
}

async function nextVersion(path: string): Promise<number> {
  let version = 2
  while (await pathExists(versionedPath(path, version))) {
    version += 1
  }
  return version
}
