export type EnrollmentStatus = "enrolled" | "waitlisted" | "old" | "unknown"

export type ScheduledPrepMeeting = {
  readonly courseCanvasId: string
  readonly startsAt: string
  readonly source: string
  readonly canceled?: boolean
}

export type ScheduledPrepPlanInput = {
  readonly meetings: readonly ScheduledPrepMeeting[]
  readonly enrollmentByCourseId: Readonly<Record<string, EnrollmentStatus>>
  readonly now: Date | string
  readonly timeZone: string
  readonly leadHours: number
  /** How long after the scheduled due time a missed run may catch up. */
  readonly windowHours: number
  readonly completedKeys?: ReadonlySet<string>
}

export type ScheduledPrepJob = {
  readonly courseCanvasId: string
  readonly startsAt: string
  readonly dueAt: string
  /** Monday of the meeting's week in the configured time zone. */
  readonly weekStart: string
  readonly idempotencyKey: string
  readonly source: string
}

export type ScheduledPrepSkipReason =
  | "not-enrolled"
  | "canceled"
  | "invalid-meeting"
  | "duplicate-week"
  | "not-due"
  | "expired"
  | "already-completed"

export type ScheduledPrepSkip = {
  readonly meeting: ScheduledPrepMeeting
  readonly reason: ScheduledPrepSkipReason
}

export type ScheduledPrepPlan = {
  readonly jobs: readonly ScheduledPrepJob[]
  readonly skipped: readonly ScheduledPrepSkip[]
}

type Candidate = {
  readonly meeting: ScheduledPrepMeeting
  readonly startsAtMs: number
  readonly weekStart: string
  readonly key: string
}

const offsetDateTime =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/i
const hourMs = 60 * 60 * 1000

/** Pure due-job selection. The caller supplies meetings, enrollment, and completed keys. */
export function planScheduledPrep(input: ScheduledPrepPlanInput): ScheduledPrepPlan {
  if (!Number.isFinite(input.leadHours) || input.leadHours < 0) {
    throw new RangeError("leadHours must be a nonnegative finite number")
  }
  if (!Number.isFinite(input.windowHours) || input.windowHours < 0) {
    throw new RangeError("windowHours must be a nonnegative finite number")
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const nowMs = input.now instanceof Date ? input.now.getTime() : parseInstant(input.now)
  if (nowMs === undefined || !Number.isFinite(nowMs)) {
    throw new RangeError("now must be a valid instant with an explicit offset")
  }

  const skipped: ScheduledPrepSkip[] = []
  const candidates: Candidate[] = []
  for (const meeting of input.meetings) {
    if (input.enrollmentByCourseId[meeting.courseCanvasId] !== "enrolled") {
      skipped.push({ meeting, reason: "not-enrolled" })
      continue
    }
    if (meeting.canceled === true) {
      skipped.push({ meeting, reason: "canceled" })
      continue
    }
    const startsAtMs = parseInstant(meeting.startsAt)
    if (
      meeting.courseCanvasId.trim().length === 0 ||
      meeting.source.trim().length === 0 ||
      startsAtMs === undefined
    ) {
      skipped.push({ meeting, reason: "invalid-meeting" })
      continue
    }
    const weekStart = localWeekStart(formatter, startsAtMs)
    candidates.push({
      meeting,
      startsAtMs,
      weekStart,
      key: `prep:${encodeURIComponent(meeting.courseCanvasId)}:${weekStart}`,
    })
  }

  candidates.sort(
    (a, b) =>
      a.startsAtMs - b.startsAtMs ||
      a.meeting.courseCanvasId.localeCompare(b.meeting.courseCanvasId) ||
      a.meeting.source.localeCompare(b.meeting.source),
  )
  const seen = new Set<string>()
  const jobs: ScheduledPrepJob[] = []
  for (const candidate of candidates) {
    const { meeting, startsAtMs, weekStart, key } = candidate
    if (seen.has(key)) {
      skipped.push({ meeting, reason: "duplicate-week" })
      continue
    }
    seen.add(key)
    if (input.completedKeys?.has(key)) {
      skipped.push({ meeting, reason: "already-completed" })
      continue
    }
    const dueMs = startsAtMs - input.leadHours * hourMs
    if (nowMs < dueMs) {
      skipped.push({ meeting, reason: "not-due" })
      continue
    }
    if (nowMs > dueMs + input.windowHours * hourMs) {
      skipped.push({ meeting, reason: "expired" })
      continue
    }
    jobs.push({
      courseCanvasId: meeting.courseCanvasId,
      startsAt: new Date(startsAtMs).toISOString(),
      dueAt: new Date(dueMs).toISOString(),
      weekStart,
      idempotencyKey: key,
      source: meeting.source,
    })
  }
  return { jobs, skipped }
}

function parseInstant(value: string): number | undefined {
  const match = offsetDateTime.exec(value)
  if (match === null) return undefined
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return undefined
  const offsetHours = Number(match[7] ?? 0)
  const offsetMinutes = Number(match[8] ?? 0)
  if (offsetHours > 23 || offsetMinutes > 59) return undefined
  const offsetMs = (match[6] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000
  const local = new Date(parsed + offsetMs)
  const canonical = `${match[1]}T${match[2]}:${match[3] ?? "00"}.${(match[4] ?? "").padEnd(3, "0")}`
  if (local.toISOString().slice(0, 23) !== canonical) return undefined
  return parsed
}

function localWeekStart(formatter: Intl.DateTimeFormat, startsAtMs: number): string {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(startsAtMs)).map((part) => [part.type, part.value]),
  ) as { year: string; month: string; day: string }
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  const date = new Date(Date.UTC(year, month - 1, day))
  const mondayOffset = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - mondayOffset)
  return date.toISOString().slice(0, 10)
}
