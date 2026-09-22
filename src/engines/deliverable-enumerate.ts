/**
 * Enumerator + part-marker parsing internals for deliverable.ts, split out
 * to keep both files under the LOC ceiling. Not part of the public
 * interface — deliverable.ts re-exports only what callers need.
 */

import type { DeliverableItem } from "./deliverable.js"

// PART markers: "PART I", "PART II", "Part A", "Part B" — roman or letter.
const partMarker = /\bpart\s+([ivx]+|[a-z])\b/gi

type PartSpan = { readonly name: string; readonly start: number; readonly end: number }

/** Splits `text` from `from` onward into PART-marker spans. Empty when no
 * PART marker is present — callers then treat the whole range as one span. */
export function findParts(text: string, from: number): readonly PartSpan[] {
  const regex = new RegExp(partMarker.source, partMarker.flags)
  regex.lastIndex = from
  const markers: Array<{
    readonly name: string
    readonly bodyStart: number
    readonly headStart: number
  }> = []
  let match = regex.exec(text)
  while (match !== null) {
    const roman = match[1] ?? ""
    markers.push({
      name: `PART ${roman.toUpperCase()}`,
      bodyStart: match.index + match[0].length,
      headStart: match.index,
    })
    match = regex.exec(text)
  }
  return markers.map((marker, index) => {
    const next = markers[index + 1]
    return {
      name: marker.name,
      start: marker.bodyStart,
      end: next === undefined ? text.length : next.headStart,
    }
  })
}

type Enumerator = {
  readonly regex: RegExp
  readonly idFrom: (raw: string, index: number) => string
  readonly first: string
}

// Enumerator forms tried, in order, at the start of a scope. Each finds
// sequential markers ("1." then "2." then "3." ...; "(a)" then "(b)" ...).
// Line-based "-"/"*" bullets are tried last since they are the least
// specific (dashes appear inside prose too).
const enumerators: readonly Enumerator[] = [
  { regex: /(?:^|\s)(\d+)\.\s+/g, idFrom: (raw) => raw, first: "1" },
  { regex: /(?:^|\s)(\d+)\)\s+/g, idFrom: (raw) => raw, first: "1" },
  { regex: /(?:^|\s)\(([a-z])\)\s+/gi, idFrom: (raw) => raw.toLowerCase(), first: "a" },
  { regex: /(?:^|\s)\(([ivx]+)\)\s+/gi, idFrom: (raw) => raw.toLowerCase(), first: "i" },
  { regex: /(?:^|\s)[-*]\s+/g, idFrom: (_raw, index) => String(index + 1), first: "" },
]

/** Parses the enumerated items inside `text.slice(from, to)`, trying each
 * enumerator form and keeping the first whose sequence actually starts at
 * that form's first id ("1", "a", "i", or any dash bullet). Returns an
 * empty array when the span has no recognizable enumeration — callers then
 * treat the span as a single unenumerated item. */
export function parseEnumeratedItems(
  text: string,
  from: number,
  to: number,
): readonly DeliverableItem[] {
  const scope = text.slice(from, to)
  for (const enumerator of enumerators) {
    const items = tryEnumerator(scope, enumerator)
    if (items.length > 0) return items
  }
  return []
}

function tryEnumerator(scope: string, enumerator: Enumerator): readonly DeliverableItem[] {
  const regex = new RegExp(enumerator.regex.source, enumerator.regex.flags)
  const markers: Array<{
    readonly id: string
    readonly headStart: number
    readonly bodyStart: number
  }> = []
  let match = regex.exec(scope)
  let index = 0
  while (match !== null) {
    const raw = match[1] ?? ""
    markers.push({
      id: enumerator.idFrom(raw, index),
      headStart: match.index,
      bodyStart: match.index + match[0].length,
    })
    index += 1
    match = regex.exec(scope)
  }
  if (markers.length === 0) return []
  const firstId = markers[0]?.id ?? ""
  if (enumerator.first !== "" && firstId !== enumerator.first) return []
  return markers.map((marker, position) => {
    const next = markers[position + 1]
    const end = next === undefined ? scope.length : next.headStart
    return { id: marker.id, text: scope.slice(marker.bodyStart, end).trim() }
  })
}
