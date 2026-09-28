import type { SchoolConfig } from "../config/index.js"

export type DatedMeeting = {
  readonly courseCanvasId: string
  readonly startsAt: string
  readonly source: "confirmed-config"
}

/** Expand only the requested date range; configured meetings are the trusted schedule. */
export function expandConfirmedMeetings(
  rules: SchoolConfig["autoPrep"]["meetings"],
  timeZone: string,
  fromDate: string,
  throughDate: string,
): readonly DatedMeeting[] {
  assertDate(fromDate)
  assertDate(throughDate)
  if (fromDate > throughDate) return []
  const meetings: DatedMeeting[] = []
  for (const rule of rules) {
    const first = rule.startsOn > fromDate ? rule.startsOn : fromDate
    const last = rule.endsOn < throughDate ? rule.endsOn : throughDate
    if (first > last) continue
    for (let date = first; date <= last; date = nextDate(date)) {
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
      if (!rule.daysOfWeek.includes(weekday)) continue
      const instant = localDateTimeToInstant(date, rule.localTime, timeZone)
      if (instant === null) continue // A nonexistent DST wall time is not a class meeting.
      meetings.push({
        courseCanvasId: rule.courseCanvasId,
        startsAt: instant,
        source: "confirmed-config",
      })
    }
  }
  return meetings.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
}

export function localDateTimeToInstant(
  date: string,
  time: string,
  timeZone: string,
): string | null {
  const [year = 0, month = 0, day = 0] = date.split("-").map(Number)
  const [hour = 0, minute = 0] = time.split(":").map(Number)
  const desired = Date.UTC(year, month - 1, day, hour, minute)
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  let instant = desired
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
    )
    const observed = Date.UTC(
      Number(parts["year"]),
      Number(parts["month"]) - 1,
      Number(parts["day"]),
      Number(parts["hour"]),
      Number(parts["minute"]),
    )
    instant += desired - observed
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  )
  if (
    Number(parts["year"]) !== year ||
    Number(parts["month"]) !== month ||
    Number(parts["day"]) !== day ||
    Number(parts["hour"]) !== hour ||
    Number(parts["minute"]) !== minute
  )
    return null
  return new Date(instant).toISOString()
}

function nextDate(date: string): string {
  const next = new Date(`${date}T12:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`Invalid schedule date: ${date}`)
  }
}
