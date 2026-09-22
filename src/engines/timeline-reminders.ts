import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { SchoolIndex } from "../store/db.js"
import type { IndexedTimelineEntry } from "../store/db-types.js"
import type { VaultWriter } from "../store/vault.js"
import { compareTimelineItems, type TimelineItem } from "./timeline.js"

const executeFile = promisify(execFile)

export type DueSoonNotifier = (title: string, message: string) => Promise<void>

class TimelineReminderError extends Error {
  readonly name = "TimelineReminderError"
}

export type DueSoonReminderInput = {
  readonly index: SchoolIndex
  readonly leadDays: number
  readonly now: Date
  readonly vault: Pick<VaultWriter, "writeMetadata">
  readonly canvasUrl: string
  readonly notify?: DueSoonNotifier
}

export async function writeDueSoonReminders(input: DueSoonReminderInput): Promise<void> {
  const end = input.now.getTime() + input.leadDays * 24 * 60 * 60 * 1000
  const reminders = input.index
    .timelineEntries()
    .flatMap((entry) => dueSoonReminder(entry, input.now.getTime(), end))
    .sort(compareTimelineItems)
  await input.vault.writeMetadata({
    artifact: "alert",
    canvasUrl: input.canvasUrl,
    content: renderAlerts(reminders),
  })
  if (reminders.length > 0) {
    await (input.notify ?? notifyWithOsascript)(
      "School agent: due soon",
      renderReminderMessage(reminders),
    )
  }
}

export async function notifyWithOsascript(title: string, message: string): Promise<void> {
  await executeFile("osascript", [
    "-e",
    `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`,
  ])
}

function dueSoonReminder(
  entry: IndexedTimelineEntry,
  start: number,
  end: number,
): readonly TimelineItem[] {
  switch (entry.kind) {
    case "announcement":
      return []
    case "assignment": {
      if (entry.dueAt === null) {
        return []
      }
      const timestamp = Date.parse(entry.dueAt)
      if (Number.isNaN(timestamp) || timestamp < start || timestamp > end) {
        return []
      }
      return [
        {
          kind: entry.kind,
          canvasId: entry.canvasId,
          courseCode: entry.courseCode,
          title: entry.title,
          at: entry.dueAt,
          actionRequired: false,
        },
      ]
    }
    default:
      return assertNever(entry)
  }
}

function renderAlerts(reminders: readonly TimelineItem[]): string {
  if (reminders.length === 0) {
    return "# Alerts\n\nNo active due-soon reminders."
  }
  return [
    "# Due-soon reminders",
    "",
    ...reminders.map((item) => `- ${item.at} — ${item.courseCode}: ${item.title}`),
  ].join("\n")
}

function renderReminderMessage(reminders: readonly TimelineItem[]): string {
  return reminders.map((item) => `${item.courseCode}: ${item.title} due ${item.at}`).join("\n")
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function assertNever(value: never): never {
  throw new TimelineReminderError(`Unexpected timeline entry: ${JSON.stringify(value)}`)
}
