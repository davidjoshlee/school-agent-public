import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname } from "node:path"

import type { SchoolConfig } from "../config/index.js"
import { isEnoent } from "../util/errors.js"
import { buildCourseManifest } from "./manifest.js"
import type { VaultDocumentKind } from "./paths.js"
import {
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
  readonly module?: { readonly number: number; readonly title: string }
  readonly moduleCanvasId?: string | number
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
    const path = courseDocumentPath(paths, input)
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
}

function courseDirectories(paths: ReturnType<typeof coursePaths>): readonly string[] {
  return [
    paths.modules,
    paths.assignments,
    paths.announcements,
    paths.files,
    paths.prep,
    paths.guidance,
    paths.drafts,
    paths.final,
    dirname(paths.playbook),
  ]
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
