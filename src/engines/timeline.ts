import type { SchoolIndex } from "../store/db.js"
import type { IndexedTimelineEntry } from "../store/db-types.js"
import { parseIcsEvents } from "./timeline-ics.js"

export type { DueSoonNotifier, DueSoonReminderInput } from "./timeline-reminders.js"
export {
  notifyWithOsascript,
  writeDueSoonReminders,
} from "./timeline-reminders.js"

export type TimelineItem = {
  readonly kind: "assignment" | "announcement"
  readonly canvasId: string
  readonly courseCode: string
  readonly title: string
  readonly at: string
  readonly actionRequired: boolean
}

export type TimelineDay = {
  readonly week: string
  readonly date: string
  readonly items: readonly TimelineItem[]
}

export type Timeline = {
  readonly dated: readonly TimelineDay[]
  readonly undated: readonly TimelineItem[]
}

export type IcsMismatch = {
  readonly title: string
  readonly courseCode: string
  readonly indexDueAt: string
  readonly icsDueAt: string
}

export type TimelineInput = {
  readonly index: SchoolIndex
  readonly weeks: number
  readonly course?: string
  readonly now: Date
}

export class TimelineError extends Error {
  readonly name = "TimelineError"
}

export function buildTimeline(input: TimelineInput): Timeline {
  const start = startOfUtcDay(input.now)
  const end = new Date(start.getTime() + input.weeks * 7 * 24 * 60 * 60 * 1000)
  const dated: TimelineItem[] = []
  const undated: TimelineItem[] = []

  for (const entry of input.index.timelineEntries()) {
    if (input.course !== undefined && entry.courseCode !== input.course) {
      continue
    }
    const item = timelineItem(entry)
    if (item === null) {
      undated.push(undatedTimelineItem(entry))
      continue
    }
    const timestamp = Date.parse(item.at)
    if (timestamp >= start.getTime() && timestamp < end.getTime()) {
      dated.push(item)
    }
  }

  const byDay = new Map<string, TimelineItem[]>()
  for (const item of dated.sort(compareTimelineItems)) {
    const date = item.at.slice(0, 10)
    const items = byDay.get(date)
    if (items === undefined) {
      byDay.set(date, [item])
    } else {
      items.push(item)
    }
  }

  return {
    dated: [...byDay.entries()].map(([date, items]) => ({
      week: isoWeek(date),
      date,
      items,
    })),
    undated: undated.sort(compareTimelineItems),
  }
}

export function renderTimeline(timeline: Timeline): string {
  const lines: string[] = []
  if (timeline.dated.length === 0) {
    lines.push("No dated items in this timeline.")
  } else {
    for (const day of timeline.dated) {
      lines.push(`## ${day.week} — ${day.date}`)
      for (const item of day.items) {
        const action = item.actionRequired ? " [ACTION]" : ""
        lines.push(`- ${item.at.slice(11, 16)} ${item.courseCode}: ${item.title}${action}`)
      }
      lines.push("")
    }
  }
  if (timeline.undated.length > 0) {
    lines.push("## Undated")
    for (const item of timeline.undated) {
      lines.push(`- ${item.courseCode}: ${item.title}`)
    }
  }
  return lines.join("\n").trim()
}

export function crossCheckIcs(input: {
  readonly index: SchoolIndex
  readonly ics: string
}): readonly IcsMismatch[] {
  const assignments = input.index.timelineEntries().filter(isDatedAssignment)
  const mismatches: IcsMismatch[] = []
  for (const event of parseIcsEvents(input.ics)) {
    for (const assignment of assignments) {
      if (assignment.title === event.title && assignment.dueAt !== event.startsAt) {
        mismatches.push({
          title: assignment.title,
          courseCode: assignment.courseCode,
          indexDueAt: assignment.dueAt,
          icsDueAt: event.startsAt,
        })
      }
    }
  }
  return mismatches
}

function timelineItem(entry: IndexedTimelineEntry): TimelineItem | null {
  switch (entry.kind) {
    case "assignment":
      return entry.dueAt === null || Number.isNaN(Date.parse(entry.dueAt))
        ? null
        : {
            kind: entry.kind,
            canvasId: entry.canvasId,
            courseCode: entry.courseCode,
            title: entry.title,
            at: entry.dueAt,
            actionRequired: false,
          }
    case "announcement":
      return entry.postedAt === null || Number.isNaN(Date.parse(entry.postedAt))
        ? null
        : {
            kind: entry.kind,
            canvasId: entry.canvasId,
            courseCode: entry.courseCode,
            title: entry.title,
            at: entry.postedAt,
            actionRequired: true,
          }
    default:
      return assertNever(entry)
  }
}

function undatedTimelineItem(entry: IndexedTimelineEntry): TimelineItem {
  let actionRequired: boolean
  switch (entry.kind) {
    case "assignment":
      actionRequired = false
      break
    case "announcement":
      actionRequired = true
      break
    default:
      return assertNever(entry)
  }
  return {
    kind: entry.kind,
    canvasId: entry.canvasId,
    courseCode: entry.courseCode,
    title: entry.title,
    at: "",
    actionRequired,
  }
}

export function compareTimelineItems(left: TimelineItem, right: TimelineItem): number {
  return left.at.localeCompare(right.at) || left.courseCode.localeCompare(right.courseCode)
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function isoWeek(date: string): string {
  const value = new Date(`${date}T00:00:00Z`)
  const day = value.getUTCDay() || 7
  value.setUTCDate(value.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((value.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

function isDatedAssignment(entry: IndexedTimelineEntry): entry is Extract<
  IndexedTimelineEntry,
  { readonly kind: "assignment" }
> & {
  readonly dueAt: string
} {
  switch (entry.kind) {
    case "assignment":
      return entry.dueAt !== null && !Number.isNaN(Date.parse(entry.dueAt))
    case "announcement":
      return false
    default:
      return assertNever(entry)
  }
}

function assertNever(value: never): never {
  throw new TimelineError(`Unexpected timeline entry: ${JSON.stringify(value)}`)
}
