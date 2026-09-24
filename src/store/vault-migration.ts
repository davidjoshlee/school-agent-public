import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path"

import { vaultLayout } from "./paths.js"
import { type ParsedVaultDocument, parseVaultDocument } from "./vault-document.js"

/** The legacy layout emitted by the original Canvas sync writer. */
export const LEGACY_VAULT_LAYOUT_VERSION = 1
/** The week/milestone-oriented layout introduced by this migration. */
export const CURRENT_VAULT_LAYOUT_VERSION = 2

const markdownExtension = vaultLayout.markdownExtension
const metadataDirectory = vaultLayout.metadata
const layoutMetadataName = vaultLayout.layoutMetadata
const oldCourseMarkers: ReadonlySet<string> = new Set([
  vaultLayout.syllabus,
  vaultLayout.index,
  vaultLayout.modules,
  vaultLayout.assignments,
  vaultLayout.announcements,
  vaultLayout.files,
  vaultLayout.prep,
  vaultLayout.guidance,
  vaultLayout.drafts,
  vaultLayout.final,
])
const v2TopLevelDirectories: ReadonlySet<string> = new Set([
  vaultLayout.assignmentsDirectory,
  vaultLayout.resources,
  vaultLayout.other,
])

export type MigrationOwnership = "sync" | "agent" | "user" | "unknown"

type DocumentInfo = {
  readonly path: string
  readonly relativePath: string
  readonly bytes: Buffer
  readonly digest: string
  readonly parsed: ParsedVaultDocument | null
  readonly ownership: MigrationOwnership
  readonly pending: boolean
}

type ModuleInfo = {
  readonly directory: string
  readonly canvasId: string
  readonly number: number
  readonly title: string
  readonly date: string | null
  readonly segment: string
}

type AssignmentInfo = {
  readonly canvasId: string
  readonly title: string
  readonly dueDate: string | null
  readonly segment: string
}

export type MigrationActionKind = "move" | "skip" | "conflict"

export type MigrationAction = {
  readonly kind: MigrationActionKind
  readonly source: string
  readonly destination: string
  readonly sourceRelative: string
  readonly destinationRelative: string
  readonly sourceDigest: string
  readonly sourceCanvasId: string | null
  readonly sourceOwnership: MigrationOwnership
  readonly pending: boolean
  readonly reason: string
}

export type MigrationCoursePlan = {
  readonly courseRoot: string
  readonly courseRelative: string
  readonly actions: readonly MigrationAction[]
  readonly warnings: readonly string[]
}

export type VaultMigrationPlan = {
  readonly root: string
  readonly sourceVersion: number
  readonly targetVersion: number
  readonly courses: readonly MigrationCoursePlan[]
  readonly actions: readonly MigrationAction[]
  readonly warnings: readonly string[]
  readonly conflicts: readonly MigrationAction[]
  readonly moves: readonly MigrationAction[]
  readonly ready: boolean
}

export type PlanVaultMigrationOptions = {
  readonly root: string
  readonly targetVersion?: number
}

export type ExecuteVaultMigrationOptions = {
  /** Used for deterministic tests and reproducible migration logs. */
  readonly now?: () => Date
}

export type VaultMigrationResult = {
  readonly plan: VaultMigrationPlan
  readonly applied: boolean
  readonly moved: readonly MigrationAction[]
  readonly skipped: readonly MigrationAction[]
}

export class VaultMigrationError extends Error {
  readonly name = "VaultMigrationError"
}

/**
 * Build a v1 -> v2 move plan without mutating the vault.
 *
 * The planner intentionally works on an explicit root supplied by the caller;
 * it never resolves or guesses a sibling `../vault` path. This keeps dry runs
 * safe and makes tests use only temporary vaults.
 */
export async function planVaultMigration(
  options: PlanVaultMigrationOptions,
): Promise<VaultMigrationPlan> {
  const root = resolve(options.root)
  const targetVersion = options.targetVersion ?? CURRENT_VAULT_LAYOUT_VERSION
  const sourceVersion = await readLayoutVersion(root)
  if (sourceVersion > targetVersion) {
    throw new VaultMigrationError(
      `Vault layout v${sourceVersion} is newer than the migration target v${targetVersion}.`,
    )
  }
  if (sourceVersion === targetVersion) {
    return {
      root,
      sourceVersion,
      targetVersion,
      courses: [],
      actions: [],
      warnings: [],
      conflicts: [],
      moves: [],
      ready: true,
    }
  }
  if (sourceVersion !== LEGACY_VAULT_LAYOUT_VERSION) {
    throw new VaultMigrationError(
      `No migration is defined from vault layout v${sourceVersion} to v${targetVersion}.`,
    )
  }

  const courseRoots = await discoverCourseRoots(root)
  const courses: MigrationCoursePlan[] = []
  for (const courseRoot of courseRoots) {
    courses.push(await planCourseMigration(root, courseRoot))
  }
  const actions = courses.flatMap((course) => course.actions)
  const warnings = courses.flatMap((course) => course.warnings)
  const conflicts = actions.filter((action) => action.kind === "conflict")
  const moves = actions.filter((action) => action.kind === "move")
  return {
    root,
    sourceVersion,
    targetVersion,
    courses,
    actions,
    warnings,
    conflicts,
    moves,
    ready: conflicts.length === 0,
  }
}

/**
 * Apply a previously-created plan. All source bytes are checked again before
 * moving, destinations are created exclusively, and layout.json is written
 * only after every move succeeds. A failed move therefore leaves the old
 * version marker in place so the next run can safely resume.
 */
export async function executeVaultMigration(
  plan: VaultMigrationPlan,
  options: ExecuteVaultMigrationOptions = {},
): Promise<VaultMigrationResult> {
  if (plan.sourceVersion === plan.targetVersion) {
    return { plan, applied: false, moved: [], skipped: [] }
  }
  if (!plan.ready) {
    throw new VaultMigrationError(
      `Migration is blocked by ${plan.conflicts.length} destination conflict(s); no files were moved.`,
    )
  }
  const moved: MigrationAction[] = []
  const skipped: MigrationAction[] = []
  try {
    for (const action of plan.moves) {
      await verifyAndMove(action, plan.root)
      moved.push(action)
    }
    await writeLayoutMetadata(plan.root, plan.sourceVersion, plan.targetVersion, options.now)
  } catch (error: unknown) {
    throw new VaultMigrationError(
      `Migration stopped before layout metadata was updated: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { plan, applied: true, moved, skipped }
}

/** Plan by default; pass `apply: true` only when the caller explicitly opts in. */
export async function migrateVault(
  options: PlanVaultMigrationOptions & ExecuteVaultMigrationOptions & { readonly apply?: boolean },
): Promise<VaultMigrationResult> {
  const plan = await planVaultMigration(options)
  if (options.apply !== true || plan.sourceVersion === plan.targetVersion) {
    return { plan, applied: false, moved: [], skipped: [] }
  }
  return executeVaultMigration(plan, options)
}

async function planCourseMigration(root: string, courseRoot: string): Promise<MigrationCoursePlan> {
  const courseRelative = relative(root, courseRoot).split(sep).join("/")
  const files = await collectDocumentInfo(courseRoot)
  const modules = moduleRecords(files)
  const assignments = assignmentRecords(files)
  const warnings: string[] = []
  const candidates: CandidateAction[] = []

  for (const document of files) {
    const destination = targetForDocument(document, courseRoot, modules, assignments)
    if (destination === null) {
      if (isLegacyOperationalFile(document.relativePath)) continue
      warnings.push(`Could not classify ${document.relativePath}; placing it in class-level Other.`)
      candidates.push({
        document,
        destination: join(courseRoot, vaultLayout.other, basename(document.path)),
        reason: "ambiguous content",
      })
      continue
    }
    if (destination === document.path) continue
    candidates.push({ document, destination, reason: targetReason(document, destination, modules) })
  }

  const disambiguated = disambiguateTargets(candidates)
  const actions = await Promise.all(
    disambiguated.map((candidate) => actionFor(candidate, courseRoot)),
  )
  return { courseRoot, courseRelative, actions, warnings }
}

type CandidateAction = {
  readonly document: DocumentInfo
  readonly destination: string
  readonly reason: string
}

function actionFor(candidate: CandidateAction, courseRoot: string): Promise<MigrationAction> {
  return destinationAction(candidate, courseRoot)
}

async function destinationAction(
  candidate: CandidateAction,
  courseRoot: string,
): Promise<MigrationAction> {
  const source = candidate.document.path
  const destination = candidate.destination
  const sourceRelative = candidate.document.relativePath
  const destinationRelative = relative(courseRoot, destination).split(sep).join("/")
  const destinationExists = await pathExists(destination)
  if (!destinationExists) {
    return {
      kind: "move",
      source,
      destination,
      sourceRelative,
      destinationRelative,
      sourceDigest: candidate.document.digest,
      sourceCanvasId: canvasId(candidate.document),
      sourceOwnership: candidate.document.ownership,
      pending: candidate.document.pending,
      reason: candidate.reason,
    }
  }

  const destinationBytes = await readFile(destination)
  const destinationDigest = digest(destinationBytes)
  const destinationInfo = await readDocumentInfo(destination, sourceRelative)
  return {
    kind: "conflict",
    source,
    destination,
    sourceRelative,
    destinationRelative,
    sourceDigest: candidate.document.digest,
    sourceCanvasId: canvasId(candidate.document),
    sourceOwnership: candidate.document.ownership,
    pending: candidate.document.pending,
    reason:
      destinationDigest === candidate.document.digest
        ? "destination already contains identical bytes; source was left untouched"
        : `destination exists${ownershipDescription(destinationInfo)}`,
  }
}

function ownershipDescription(document: DocumentInfo | null): string {
  if (document === null) return ""
  if (document.pending) return "; destination is a pending draft"
  if (document.ownership === "user") return "; destination is user-owned"
  return ""
}

async function verifyAndMove(action: MigrationAction, root: string): Promise<void> {
  if (!(await pathExists(action.source))) {
    throw new VaultMigrationError(`Source disappeared before move: ${action.sourceRelative}`)
  }
  const sourceBytes = await readFile(action.source)
  if (digest(sourceBytes) !== action.sourceDigest) {
    throw new VaultMigrationError(`Source changed after planning: ${action.sourceRelative}`)
  }
  if (!isWithin(resolve(action.destination), resolve(root))) {
    throw new VaultMigrationError(`Refusing destination outside vault root: ${action.destination}`)
  }
  if (await pathExists(action.destination)) {
    throw new VaultMigrationError(`Destination appeared before move: ${action.destinationRelative}`)
  }
  await mkdir(dirname(action.destination), { recursive: true })
  await moveExclusive(action.source, action.destination)
}

async function moveExclusive(source: string, destination: string): Promise<void> {
  try {
    // A hard link followed by unlink is atomic with respect to destination
    // existence on the same filesystem and cannot overwrite an existing file.
    await link(source, destination)
    await unlink(source)
  } catch (error: unknown) {
    const code = errorCode(error)
    if (code === "EEXIST") {
      throw new VaultMigrationError(`Destination appeared before move: ${destination}`)
    }
    if (code !== "EXDEV" && code !== "EPERM" && code !== "EOPNOTSUPP") throw error
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL)
    await unlink(source)
  }
}

async function writeLayoutMetadata(
  root: string,
  sourceVersion: number,
  targetVersion: number,
  now: () => Date = () => new Date(),
): Promise<void> {
  const metadataRoot = join(root, metadataDirectory)
  const path = join(metadataRoot, layoutMetadataName)
  let previous: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (isRecord(parsed)) previous = parsed
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") throw error
  }
  const content = `${JSON.stringify(
    {
      ...previous,
      layout_version: targetVersion,
      migrated_from: sourceVersion,
      migrated_at: now().toISOString(),
    },
    null,
    2,
  )}\n`
  await mkdir(metadataRoot, { recursive: true })
  const temporary = `${path}.migration-${process.pid}-${Date.now()}.tmp`
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" })
  try {
    await rename(temporary, path)
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function readLayoutVersion(root: string): Promise<number> {
  const path = join(root, metadataDirectory, layoutMetadataName)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return LEGACY_VAULT_LAYOUT_VERSION
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    throw new VaultMigrationError(`Unreadable layout metadata at ${path}: ${String(error)}`)
  }
  if (!isRecord(parsed) || typeof recordValue(parsed, "layout_version") !== "number") {
    throw new VaultMigrationError(`Layout metadata at ${path} has no numeric layout_version.`)
  }
  return recordValue(parsed, "layout_version") as number
}

async function discoverCourseRoots(root: string): Promise<readonly string[]> {
  const entries = await safeReadDirectory(root)
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .filter((entry) => entry.name !== metadataDirectory)
    .map((entry) => join(root, entry.name))
  const roots = []
  for (const directory of directories) {
    if (await hasLegacyCourseMarker(directory)) roots.push(directory)
  }
  if (roots.length > 0) return roots.sort()
  return (await hasLegacyCourseMarker(root)) ? [root] : []
}

async function hasLegacyCourseMarker(directory: string): Promise<boolean> {
  const entries = await safeReadDirectory(directory)
  return entries.some((entry) => oldCourseMarkers.has(entry.name))
}

async function collectDocumentInfo(courseRoot: string): Promise<DocumentInfo[]> {
  const paths = await collectFiles(courseRoot)
  const documents: DocumentInfo[] = []
  for (const path of paths) {
    const relativePath = relative(courseRoot, path).split(sep).join("/")
    if (isLegacyOperationalFile(relativePath) || isV2Path(relativePath)) continue
    documents.push(await readDocumentInfo(path, relativePath))
  }
  return documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

async function collectFiles(directory: string): Promise<readonly string[]> {
  const entries = await safeReadDirectory(directory)
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name === metadataDirectory || entry.name === ".git" || entry.name.startsWith(".")) {
      continue
    }
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(path)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function readDocumentInfo(path: string, relativePath: string): Promise<DocumentInfo> {
  const bytes = await readFile(path)
  let parsed: ParsedVaultDocument | null = null
  if (extname(path).toLowerCase() === markdownExtension) {
    try {
      parsed = parseVaultDocument(bytes.toString("utf8"), path)
    } catch {
      // A user may have a plain Markdown note in the old vault. It remains
      // byte-for-byte intact and is classified as ambiguous content.
    }
  }
  return {
    path,
    relativePath,
    bytes,
    digest: digest(bytes),
    parsed,
    ownership: parsed?.frontmatter.source ?? "unknown",
    pending: parsed?.frontmatter.status === "draft",
  }
}

function moduleRecords(files: readonly DocumentInfo[]): ReadonlyMap<string, ModuleInfo> {
  const records = new Map<string, ModuleInfo>()
  const canonical = new Map<string, ModuleInfo>()
  for (const file of files) {
    const parts = file.relativePath.split("/")
    if (parts[0] !== "modules" || parts.length < 2) continue
    const directory = parts[1]
    if (directory === undefined) continue
    const parsedName = parseModuleDirectory(directory)
    if (parsedName === null) continue
    const frontmatter = file.parsed?.frontmatter
    if (frontmatter?.type !== "modules" && parts.length !== 2) continue
    const canvasId = frontmatter?.canvas_id ?? parsedName.canvasId
    if (frontmatter?.module_canvas_id !== undefined) continue
    const title = moduleTitle(file, parsedName.title)
    const date = dateFrom(frontmatter?.dates, ["session_at", "unlock_at", "created_at"])
    const segment = weekSegment(parsedName.number, title, date)
    const module: ModuleInfo = {
      directory,
      canvasId,
      number: parsedName.number,
      title,
      date,
      segment,
    }
    records.set(directory, module)
    canonical.set(canvasId, module)
  }
  // Old syncs stored every module item in a sibling directory named after the
  // item id. Its module_canvas_id is the durable link back to the canonical
  // module. Point those directories at the one canonical week instead of
  // creating one week/overview per page or file item.
  for (const file of files) {
    const parts = file.relativePath.split("/")
    if (parts[0] !== "modules" || parts.length < 2) continue
    const directory = parts[1]
    if (directory === undefined || records.has(directory)) continue
    const moduleId = file.parsed?.frontmatter.module_canvas_id
    if (moduleId === undefined) continue
    const module = canonical.get(moduleId)
    if (module !== undefined) records.set(directory, module)
  }
  return records
}

function assignmentRecords(files: readonly DocumentInfo[]): ReadonlyMap<string, AssignmentInfo> {
  const records = new Map<string, AssignmentInfo>()
  for (const file of files) {
    const type = file.parsed?.frontmatter.type
    if (type !== "assignments") continue
    const canvasId = file.parsed?.frontmatter.canvas_id
    if (canvasId === undefined || records.has(canvasId)) continue
    const title = titleFromFilename(file.path)
    const dueDate = dateFrom(file.parsed?.frontmatter.dates, ["due_at", "posted_at", "created_at"])
    records.set(canvasId, {
      canvasId,
      title,
      dueDate,
      segment: assignmentSegment(title, dueDate),
    })
  }
  return records
}

function targetForDocument(
  document: DocumentInfo,
  courseRoot: string,
  modules: ReadonlyMap<string, ModuleInfo>,
  assignments: ReadonlyMap<string, AssignmentInfo>,
): string | null {
  const relativePath = document.relativePath
  const parts = relativePath.split("/")
  const top = parts[0] ?? ""
  const frontmatter = document.parsed?.frontmatter
  // `_index.md` remains the machine manifest. The v2 sync/navigation writer
  // owns the separately-generated `00 Home.md`; moving the manifest would
  // break retrieval and would also change its stable Canvas identity.
  if (top === "_index.md") return document.path
  if (top === vaultLayout.syllabus) {
    return join(courseRoot, vaultLayout.resources, vaultLayout.syllabusFile)
  }
  if (parts[0] === "modules") {
    const directory = parts[1]
    if (directory === undefined) return classOtherPath(courseRoot, document.path)
    const module = modules.get(directory)
    if (module === undefined) return classOtherPath(courseRoot, document.path)
    if (module.number === 0 || module.date === null)
      return classOtherPath(courseRoot, document.path)
    const kind = frontmatter?.type
    if (kind === "assignments" || isFeedbackKind(kind) || kind === "drafts" || kind === "final") {
      return assignmentTarget(document, courseRoot, assignments, kind ?? "")
    }
    if (kind === "modules" && parts.length === 3 && frontmatter?.module_canvas_id === undefined) {
      return join(courseRoot, module.segment, vaultLayout.overview)
    }
    if (kind === "prep" || kind === "guidance") {
      return join(
        courseRoot,
        module.segment,
        vaultLayout.prepDirectory,
        targetBasename(document.path),
      )
    }
    if (kind === "announcements") {
      return join(courseRoot, module.segment, vaultLayout.other, targetBasename(document.path))
    }
    if (kind === "files" || kind === "modules") {
      return join(courseRoot, module.segment, vaultLayout.materials, targetBasename(document.path))
    }
    // A malformed/unknown module child has no reliable semantic category.
    return classOtherPath(courseRoot, document.path)
  }

  const associatedModule = moduleForDocument(document, modules)
  const kind = frontmatter?.type
  if (kind === "assignments" || isFeedbackKind(kind) || kind === "drafts" || kind === "final") {
    return assignmentTarget(document, courseRoot, assignments, kind ?? "")
  }
  if (top === "files" || kind === "files") {
    if (/syllabus/i.test(basename(document.path))) {
      return join(courseRoot, vaultLayout.resources, targetBasename(document.path))
    }
    return associatedModule === null
      ? join(
          courseRoot,
          vaultLayout.resources,
          vaultLayout.filesDirectory,
          targetBasename(document.path),
        )
      : join(
          courseRoot,
          associatedModule.segment,
          vaultLayout.materials,
          targetBasename(document.path),
        )
  }
  if (top === "prep" || kind === "prep") {
    return associatedModule === null
      ? join(
          courseRoot,
          vaultLayout.other,
          vaultLayout.prepDirectory,
          targetBasename(document.path),
        )
      : join(
          courseRoot,
          associatedModule.segment,
          vaultLayout.prepDirectory,
          targetBasename(document.path),
        )
  }
  if (top === "announcements" || kind === "announcements") {
    return join(
      courseRoot,
      vaultLayout.other,
      vaultLayout.announcementsDirectory,
      targetBasename(document.path),
    )
  }
  if (top === "guidance" || kind === "guidance") {
    return join(
      courseRoot,
      vaultLayout.resources,
      vaultLayout.guidanceDirectory,
      targetBasename(document.path),
    )
  }
  if (top === "drafts" || top === "final") {
    return assignmentTarget(
      document,
      courseRoot,
      assignments,
      top === "drafts" ? "drafts" : "final",
    )
  }
  return classOtherPath(courseRoot, document.path)
}

function assignmentTarget(
  document: DocumentInfo,
  courseRoot: string,
  assignments: ReadonlyMap<string, AssignmentInfo>,
  kind: string,
): string {
  const canvasId = assignmentCanvasId(document, kind)
  const assignment =
    (canvasId === null ? undefined : assignments.get(canvasId)) ??
    assignmentByFilename(document.path, assignments)
  if (assignment === undefined) return classOtherPath(courseRoot, document.path)
  const assignmentRoot = join(courseRoot, vaultLayout.assignmentsDirectory, assignment.segment)
  if (kind === vaultLayout.assignments) return join(assignmentRoot, vaultLayout.prompt)
  if (isFeedbackKind(kind)) return join(assignmentRoot, vaultLayout.feedbackFile)
  return join(
    assignmentRoot,
    kind === vaultLayout.drafts ? vaultLayout.draftsDirectory : vaultLayout.finalDirectory,
    targetBasename(document.path),
  )
}

function moduleForDocument(
  document: DocumentInfo,
  modules: ReadonlyMap<string, ModuleInfo>,
): ModuleInfo | null {
  const moduleId = document.parsed?.frontmatter.module_canvas_id
  if (moduleId !== undefined) {
    for (const module of modules.values()) {
      if (module.canvasId === moduleId) return module
    }
  }
  const dates = document.parsed?.frontmatter.dates
  const periodValue = dates === undefined ? undefined : recordValue(dates, "period")
  const periodDate = typeof periodValue === "string" ? dateToken(periodValue) : null
  if (periodDate !== null) {
    for (const module of modules.values()) {
      if (module.date !== null && module.date.slice(0, 10) === periodDate) return module
    }
  }
  return null
}

function assignmentCanvasId(document: DocumentInfo, kind: string): string | null {
  const id = document.parsed?.frontmatter.canvas_id
  if (id === undefined) return null
  if (isFeedbackKind(kind) && id.endsWith("-feedback")) {
    return id.slice(0, -"-feedback".length)
  }
  return id
}

function assignmentByFilename(
  path: string,
  assignments: ReadonlyMap<string, AssignmentInfo>,
): AssignmentInfo | undefined {
  const candidate = titleKey(titleFromFilename(path))
  if (candidate.length === 0) return undefined
  for (const assignment of assignments.values()) {
    if (titleKey(assignment.title) === candidate) return assignment
  }
  return undefined
}

function isFeedbackKind(kind: string | undefined): boolean {
  return kind === "feedback" || kind === ".feedback.md" || kind?.endsWith("feedback.md") === true
}

function disambiguateTargets(candidates: readonly CandidateAction[]): readonly CandidateAction[] {
  const byDestination = new Map<string, CandidateAction[]>()
  for (const candidate of candidates) {
    const list = byDestination.get(candidate.destination) ?? []
    list.push(candidate)
    byDestination.set(candidate.destination, list)
  }
  const result: CandidateAction[] = []
  for (const peers of byDestination.values()) {
    const ordered = [...peers].sort((left, right) =>
      left.document.relativePath.localeCompare(right.document.relativePath),
    )
    for (const [index, candidate] of ordered.entries()) {
      result.push({
        ...candidate,
        destination:
          index === 0 ? candidate.destination : appendOrdinal(candidate.destination, index + 1),
      })
    }
  }
  return result.sort((left, right) =>
    left.document.relativePath.localeCompare(right.document.relativePath),
  )
}

function targetReason(
  document: DocumentInfo,
  destination: string,
  modules: ReadonlyMap<string, ModuleInfo>,
): string {
  if (destination.includes(`${sep}Assignments${sep}`))
    return "assignment grouped with prompt, drafts, final, and feedback"
  if (destination.includes(`${sep}Resources${sep}`)) return "course-wide reference"
  if (destination.includes(`${sep}Other${sep}`)) return "ambiguous or course-wide content"
  for (const module of modules.values()) {
    if (destination.includes(`${sep}${module.segment}${sep}`)) {
      return document.parsed?.frontmatter.module_canvas_id === undefined
        ? "module content grouped under its week"
        : "content linked to its Canvas module"
    }
  }
  return "legacy layout normalization"
}

function moduleTitle(document: DocumentInfo, fallback: string): string {
  const first = document.parsed?.content
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0)
  return first ?? fallback
}

function parseModuleDirectory(
  value: string,
): { readonly number: number; readonly title: string; readonly canvasId: string } | null {
  const match = /^(\d+)-(.+)$/.exec(value)
  if (match === null || match[1] === undefined || match[2] === undefined) return null
  const number = Number.parseInt(match[1], 10)
  const remainder = match[2]
  const idSeparator = remainder.lastIndexOf("-")
  const canvasId = idSeparator > 0 ? remainder.slice(idSeparator + 1) : remainder
  const titleSlug = idSeparator > 0 ? remainder.slice(0, idSeparator) : remainder
  return { number, title: titleFromSlug(titleSlug), canvasId }
}

function weekSegment(number: number, title: string, date: string | null): string {
  const prefix = /\bmilestone\b/i.test(title) ? "Milestone" : "Week"
  const numberLabel = String(number).padStart(2, "0")
  const label = date === null ? title : formatDateLabel(date)
  return sanitizeSegment(`${prefix} ${numberLabel}${label.length === 0 ? "" : ` - ${label}`}`)
}

function assignmentSegment(title: string, dueDate: string | null): string {
  const prefix = dueDate === null ? "Undated" : dueDate.slice(0, 10)
  return sanitizeSegment(`${prefix} - ${title}`)
}

function dateFrom(
  dates: Readonly<Record<string, string | null>> | undefined,
  fields: readonly string[],
): string | null {
  if (dates === undefined) return null
  for (const field of fields) {
    const value = dates[field]
    if (value !== undefined && value !== null && Number.isFinite(Date.parse(value))) {
      return value
    }
  }
  return null
}

function dateToken(value: string): string | null {
  const match = /\b(\d{4}-\d{2}-\d{2})\b/.exec(value)
  return match?.[1] ?? null
}

function formatDateLabel(date: string): string {
  const parsed = new Date(date)
  if (!Number.isFinite(parsed.getTime())) return ""
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed)
}

function titleFromFilename(path: string): string {
  return titleFromSlug(
    basename(path, extname(path))
      .replace(/\.feedback$/, "")
      .replace(/\.v\d+$/i, ""),
  )
}

function titleKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function titleFromSlug(value: string): string {
  const title = value
    .replace(/^[0-9]+-/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return title.length === 0 ? "Untitled" : title.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function classOtherPath(courseRoot: string, path: string): string {
  return join(courseRoot, vaultLayout.other, targetBasename(path))
}

function targetBasename(path: string): string {
  return basename(path)
}

function appendOrdinal(path: string, ordinal: number): string {
  const extension = extname(path)
  const base = extension.length === 0 ? path : path.slice(0, -extension.length)
  return `${base} (${ordinal})${extension}`
}

function sanitizeSegment(value: string): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  return normalized
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "")
    .slice(0, 120)
}

function isV2Path(relativePath: string): boolean {
  const parts = relativePath.split("/")
  const first = parts[0] ?? ""
  return (
    first === "00 Home.md" ||
    v2TopLevelDirectories.has(first) ||
    first.startsWith("Week ") ||
    first.startsWith("Milestone ")
  )
}

function isLegacyOperationalFile(relativePath: string): boolean {
  return relativePath.startsWith(`${metadataDirectory}/`) || relativePath === ".DS_Store"
}

function canvasId(document: DocumentInfo): string | null {
  return document.parsed?.frontmatter.canvas_id ?? null
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function isWithin(path: string, parent: string): boolean {
  const pathToParent = relative(parent, path)
  return (
    pathToParent === "" || (!pathToParent.startsWith("..") && !pathToParent.startsWith(`..${sep}`))
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? false : Promise.reject(error)
  }
}

async function safeReadDirectory(path: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return []
    throw error
  }
}

function errorCode(error: unknown): string | undefined {
  const code = isRecord(error) ? recordValue(error, "code") : undefined
  return typeof code === "string" ? code : undefined
}

function recordValue(record: Record<string, unknown>, key: string): unknown {
  return record[key]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
