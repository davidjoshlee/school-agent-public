import { slugify, vaultLayout } from "../store/paths.js"
import { buildModuleMembership } from "./retrieve-module-index.js"
import { type CourseModule, loadCourseModules } from "./retrieve-modules.js"

/**
 * Turns Canvas module structure into the primary candidate path list for
 * `assembleCourseContext` (see retrieve.ts's `selection` input), replacing
 * keyword scoring for the two callers that know a specific target: a single
 * assignment (assignment.ts) or a dated/numbered period (prep.ts). Neither
 * selector ever throws — when nothing in the vault's module structure
 * matches, callers get `{ mode: "keyword-fallback" }` and fall back to the
 * existing keyword selection, with that degraded mode visible in the
 * context log.
 */
export type ModuleSelection =
  | {
      readonly mode: "module"
      readonly paths: readonly string[]
      readonly moduleCanvasIds: readonly string[]
      readonly moduleTitles: readonly string[]
    }
  | { readonly mode: "keyword-fallback" }

// session_at is the derived signal a module carries when it names a
// specific class session (e.g. "Session 8 (October 16)"); created_at is
// deliberately excluded here — it's a bulk-setup artifact, not a release
// signal (see simulate-visibility.ts's courseSetupCutoff).
const moduleDateSignals = ["unlock_at", "session_at"] as const

export async function selectModulesForAssignment(
  courseRoot: string,
  assignment: { readonly canvasId: string; readonly title: string },
): Promise<ModuleSelection> {
  const [modules, membership] = await Promise.all([
    loadCourseModules(courseRoot),
    buildModuleMembership(courseRoot),
  ])
  const slug = slugify(assignment.title, "")
  const matched = modules.filter((module) =>
    module.items.some(
      (item) =>
        item.type === "Assignment" &&
        (item.canvasId === assignment.canvasId ||
          (item.resolvedPath !== undefined && assignmentPathMatches(item.resolvedPath, slug))),
    ),
  )
  if (matched.length === 0) return { mode: "keyword-fallback" }

  const firstPosition = Math.min(...matched.map((module) => module.position))
  const preceding = modules
    .filter((module) => module.position < firstPosition)
    .sort((left, right) => right.position - left.position)[0]
  const involved = preceding === undefined ? matched : [...matched, preceding]

  return {
    mode: "module",
    paths: dedupedPaths(involved, membership),
    moduleCanvasIds: involved.map((module) => module.canvasId),
    moduleTitles: involved.map((module) => module.title),
  }
}

export async function selectModulesForPeriod(
  courseRoot: string,
  period: { readonly kind: "week" | "session"; readonly value: string },
): Promise<ModuleSelection> {
  const [modules, membership] = await Promise.all([
    loadCourseModules(courseRoot),
    buildModuleMembership(courseRoot),
  ])
  const matched =
    period.kind === "session"
      ? matchBySession(modules, period.value)
      : matchByWeek(modules, period.value)
  if (matched.length === 0) return { mode: "keyword-fallback" }
  return {
    mode: "module",
    paths: dedupedPaths(matched, membership),
    moduleCanvasIds: matched.map((module) => module.canvasId),
    moduleTitles: matched.map((module) => module.title),
  }
}

function matchBySession(
  modules: readonly CourseModule[],
  sessionValue: string,
): readonly CourseModule[] {
  const pattern = new RegExp(`\\bsession\\s+${escapeRegExp(sessionValue)}\\b`, "i")
  return modules.filter((module) => pattern.test(module.title))
}

function matchByWeek(modules: readonly CourseModule[], dateValue: string): readonly CourseModule[] {
  const start = Date.parse(dateValue)
  if (!Number.isFinite(start)) return []
  const end = start + 7 * 24 * 60 * 60 * 1000
  return modules.filter(
    (module) =>
      inWindow(effectiveModuleDate(module), start, end) ||
      module.items.some((item) => inWindow(item.dueAt ?? null, start, end)),
  )
}

function inWindow(value: string | null, start: number, end: number): boolean {
  if (value === null) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= start && parsed < end
}

function effectiveModuleDate(module: CourseModule): string | null {
  for (const signal of moduleDateSignals) {
    const value = module.dates[signal]
    if (value !== undefined && value !== null) return value
  }
  return null
}

function dedupedPaths(
  modules: readonly CourseModule[],
  membership: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const module of modules) {
    if (!seen.has(module.path)) {
      seen.add(module.path)
      paths.push(module.path)
    }
    for (const item of module.items) {
      if (item.resolvedPath === undefined || seen.has(item.resolvedPath)) continue
      seen.add(item.resolvedPath)
      paths.push(item.resolvedPath)
    }
    // Reverse-linked docs: anything carrying `module_canvas_id: <this
    // module>` in frontmatter, whether or not it appears in the module root
    // doc's item list (a manually `ingest --module`-tagged file, notably).
    for (const path of membership.get(module.canvasId) ?? []) {
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }
  }
  return paths
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function assignmentPathMatches(path: string, titleSlug: string): boolean {
  if (path === `assignments/${titleSlug}.md`) return true
  const parts = path.split("/")
  const index = parts.findIndex(
    (part) => part === vaultLayout.assignmentsDirectory || part === vaultLayout.assignments,
  )
  const directory = index < 0 ? undefined : parts[index + 1]
  if (directory === undefined) return false
  const title = directory
    .replace(/^\d{4}-\d{2}-\d{2}\s+-\s+/, "")
    .replace(/^Undated\s+-\s+/i, "")
    .replace(/^Assignment\s+-\s+/i, "")
  return slugify(title, "") === titleSlug
}
