/**
 * The as-of visibility rule for simulate's replay clock (see
 * docs/DECISIONS.md's "as-of clock" entry and the CTO review that prompted
 * this file). Canvas assignments/files are usually all created at course
 * setup, so a bare `created_at` fallback makes nearly everything "visible"
 * from day one — the original bug this file fixes. The precedence below
 * makes visibility structural instead:
 *
 *   a. own unlock_at / posted_at (an explicit Canvas release date) — always
 *      trusted.
 *   b. the containing module's release: the module's own unlock_at, else its
 *      derived session_at minus a lead (a module is usually visible some
 *      days before the session it names, e.g. so students can pre-read).
 *      This also covers a module document about itself (its `dates` already
 *      carry unlock_at/session_at directly — see `moduleDates` in
 *      sync-render.ts) as well as any assignment/file/page doc carrying
 *      `module_canvas_id`.
 *   c. own due_at — an item is certainly visible by the time it's due.
 *   d. own created_at, but ONLY if it postdates `courseSetupCutoff` — a
 *      created_at at or before the cutoff is a bulk-setup artifact (every
 *      Canvas resource in a course is typically created the day the course
 *      shell is built) and is never trusted as a release signal.
 *   e. otherwise unknown (counted, never leaked — same contract as before).
 */

export const MODULE_RELEASE_LEAD_DAYS = 7

export const visibilitySignals = [
  "unlock_at",
  "posted_at",
  "module_release",
  "due_at",
  "created_at",
  "unknown",
] as const
export type VisibilitySignal = (typeof visibilitySignals)[number]

export type DocumentVisibility = {
  readonly visibleAt: string | null
  readonly signal: VisibilitySignal
}

export type ModuleDatesById = ReadonlyMap<string, Readonly<Record<string, string | null>>>

/**
 * The earliest point at which any date-bearing resource in a course could
 * genuinely have been released, computed from the course's own module
 * `session_at`s and assignment `due_at`s (the "the course term start if
 * known" alternative from the spec is not available in the synced vault
 * today; the whole-course session_at/due_at floor is the honest signal we
 * do have). A `created_at` at or before this cutoff is bulk-setup noise;
 * one strictly after it is presumed to reflect a genuine later addition.
 */
export function courseSetupCutoff(
  moduleDatesById: ModuleDatesById,
  assignmentDueAts: readonly (string | null | undefined)[],
): string | null {
  const candidates: number[] = []
  for (const dates of moduleDatesById.values()) {
    const sessionAt = parseDay(dates["session_at"])
    if (sessionAt !== null) candidates.push(sessionAt)
  }
  for (const dueAt of assignmentDueAts) {
    const parsed = parseDay(dueAt)
    if (parsed !== null) candidates.push(parsed)
  }
  if (candidates.length === 0) return null
  const earliest = Math.min(...candidates)
  return toDay(earliest - 14 * 24 * 60 * 60 * 1000)
}

export function computeVisibility(
  dates: Readonly<Record<string, string | null>>,
  moduleCanvasId: string | undefined,
  moduleDatesById: ModuleDatesById,
  setupCutoff: string | null,
): DocumentVisibility {
  const unlock = readDay(dates, "unlock_at")
  if (unlock !== null) return { visibleAt: unlock, signal: "unlock_at" }
  const posted = readDay(dates, "posted_at")
  if (posted !== null) return { visibleAt: posted, signal: "posted_at" }

  const moduleRelease = releaseDate(dates, moduleCanvasId, moduleDatesById)
  if (moduleRelease !== null) return { visibleAt: moduleRelease, signal: "module_release" }

  const dueAt = readDay(dates, "due_at")
  if (dueAt !== null) return { visibleAt: dueAt, signal: "due_at" }

  const createdAt = readDay(dates, "created_at")
  if (createdAt !== null && setupCutoff !== null && createdAt > setupCutoff) {
    return { visibleAt: createdAt, signal: "created_at" }
  }
  return { visibleAt: null, signal: "unknown" }
}

/**
 * A document is "in" a module either because it IS a module document (its
 * own `dates` already carry the module's unlock_at/session_at — see
 * `moduleDates`) or because it references one via `module_canvas_id`. Either
 * way, the release is the module's unlock_at, else its session_at minus the
 * lead.
 */
function releaseDate(
  ownDates: Readonly<Record<string, string | null>>,
  moduleCanvasId: string | undefined,
  moduleDatesById: ModuleDatesById,
): string | null {
  const moduleDates =
    ownDates["session_at"] !== undefined && ownDates["session_at"] !== null
      ? ownDates
      : moduleCanvasId === undefined
        ? undefined
        : moduleDatesById.get(moduleCanvasId)
  if (moduleDates === undefined) return null
  const unlock = readDay(moduleDates, "unlock_at")
  if (unlock !== null) return unlock
  const sessionAt = readDay(moduleDates, "session_at")
  if (sessionAt === null) return null
  return toDay(Date.parse(sessionAt) - MODULE_RELEASE_LEAD_DAYS * 24 * 60 * 60 * 1000)
}

function readDay(dates: Readonly<Record<string, string | null>>, key: string): string | null {
  const parsed = parseDay(dates[key])
  return parsed === null ? null : toDay(parsed)
}

function parseDay(value: string | null | undefined): number | null {
  if (value === undefined || value === null) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}
