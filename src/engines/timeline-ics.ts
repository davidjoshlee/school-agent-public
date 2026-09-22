export type IcsEvent = { readonly title: string; readonly startsAt: string }

export function parseIcsEvents(ics: string): readonly IcsEvent[] {
  const events: IcsEvent[] = []
  let lines: readonly string[] = []
  for (const line of ics.replaceAll("\r\n", "\n").split("\n")) {
    if (line === "BEGIN:VEVENT") {
      lines = []
      continue
    }
    if (line === "END:VEVENT") {
      const title = icsValue(lines, "SUMMARY")
      const startsAt = icsDate(icsValue(lines, "DTSTART"))
      if (title !== null && startsAt !== null) {
        events.push({ title, startsAt })
      }
      continue
    }
    lines = [...lines, line]
  }
  return events
}

function icsValue(lines: readonly string[], name: string): string | null {
  const line = lines.find((candidate) => candidate.startsWith(name))
  if (line === undefined) {
    return null
  }
  const separator = line.indexOf(":")
  return separator === -1 ? null : line.slice(separator + 1)
}

function icsDate(value: string | null): string | null {
  if (value === null || !/^\d{8}T\d{6}Z$/.test(value)) {
    return null
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`
}
