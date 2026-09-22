/**
 * Turns a finished draft's Markdown body into `Sheet`s for the accompanying
 * workbook: one sheet per GitHub-flavored Markdown table, plus a
 * `Computations` sheet parsed from the draft's `## Computations` section
 * (the same `label — value` bullet format `calculationDirective` in
 * `engines/assignment.ts` mandates and `assignment-review.ts` already treats
 * as contract). Pure text-in, `Sheet[]`-out — no I/O, so it's cheap to unit
 * test in isolation.
 */

import type { Sheet } from "./xlsx.js"

const headingLine = /^#{1,6}\s+(.+)$/
const computationsHeading = /^##\s+Computations\s*$/
const computationLine = /^-?\s*(.+?)\s+—\s+(.+)$/

// Header words that name a COLUMN'S ROLE, not the account/item the table is
// about — e.g. a T-account's header row is `Ref | Description | Debit |
// Credit`, none of which distinguish one table from the next. This is only
// a fallback for the rare table with no preceding heading at all: three
// heuristic attempts to *guess* a real name from cell contents (a
// distinctive header word alone, then also reading the first data row) each
// mis-fired on live drafts — grabbing row labels, transaction descriptions,
// or a misclassified bare number. The reliable fix is `tabularOutputDirective`
// in `engines/assignment.ts`, which now requires the model to precede EVERY
// table with its own heading naming what it is; `extractTables` below reads
// that heading as the primary name and only falls back to a header guess
// when the model didn't supply one.
const genericHeaderWords = new Set([
  "debit",
  "credit",
  "label",
  "value",
  "description",
  "ref",
  "amount",
])

function isTableLine(line: string): boolean {
  return line.trim().startsWith("|")
}

function splitTableRow(line: string): readonly string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map((cell) => cell.trim())
}

function isSeparatorRow(line: string): boolean {
  if (!isTableLine(line)) {
    return false
  }
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

// A header cell like "Amount ($)" is still the generic "amount" column, so
// matching against the generic-word set ignores a trailing parenthetical.
function normalizedHeaderWord(cell: string): string {
  return cell
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .trim()
}

/**
 * The first header cell that isn't a generic column-role word — e.g. "Cash
 * ($M)" out of `Cash ($M) | Debit | Credit` — or `null` when every header
 * cell is generic (or the table has no header row).
 */
function distinctiveHeaderName(headerRow: readonly string[] | undefined): string | null {
  if (headerRow === undefined) {
    return null
  }
  for (const cell of headerRow) {
    const trimmed = cell.trim()
    if (trimmed.length > 0 && !genericHeaderWords.has(normalizedHeaderWord(trimmed))) {
      return trimmed
    }
  }
  return null
}

/**
 * Every Markdown table in `draft`, named by (in order): the nearest
 * preceding heading (primary — `tabularOutputDirective` requires the model
 * to put one immediately above every table, naming what it is), else a
 * distinctive header cell, else `Table N`. Sanitizing illegal characters,
 * truncating, and de-duplicating repeats happens later, in
 * `buildXlsx`/`sanitizeSheetNames` — this only picks the best RAW name.
 */
export function extractTables(draft: string): readonly Sheet[] {
  const lines = draft.split("\n")
  const tables: Sheet[] = []
  let heading: string | null = null
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ""
    const headingMatch = headingLine.exec(line.trim())
    if (headingMatch !== null) {
      heading = (headingMatch[1] ?? "").trim()
      index += 1
      continue
    }
    if (isTableLine(line) && isSeparatorRow(lines[index + 1] ?? "")) {
      const rows: string[][] = [[...splitTableRow(line)]]
      index += 2
      while (index < lines.length && isTableLine(lines[index] ?? "")) {
        rows.push([...splitTableRow(lines[index] ?? "")])
        index += 1
      }
      const name = heading ?? distinctiveHeaderName(rows[0]) ?? `Table ${tables.length + 1}`
      tables.push({ name, rows })
      continue
    }
    index += 1
  }
  return tables
}

/** The `Computations` sheet (two columns: label, value) from the draft's
 * `## Computations` section, or `null` when the section is absent/empty. */
export function extractComputationsSheet(draft: string): Sheet | null {
  const lines = draft.split("\n")
  const start = lines.findIndex((line) => computationsHeading.test(line.trim()))
  if (start === -1) {
    return null
  }
  const rows: string[][] = [["Label", "Value"]]
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (headingLine.test(line.trim())) {
      break
    }
    const match = computationLine.exec(line.trim())
    if (match !== null) {
      rows.push([(match[1] ?? "").trim(), (match[2] ?? "").trim()])
    }
  }
  return rows.length > 1 ? { name: "Computations", rows } : null
}

/** All sheets a draft's body yields, or `[]` when it has no tables and no
 * `## Computations` section — callers should write no workbook in that case. */
export function sheetsFromDraft(draft: string): readonly Sheet[] {
  const computations = extractComputationsSheet(draft)
  const tables = extractTables(draft)
  return computations === null ? tables : [...tables, computations]
}
