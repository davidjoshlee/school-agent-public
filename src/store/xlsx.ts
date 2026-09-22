/**
 * Minimal `.xlsx` writer: a workbook is just a ZIP of a handful of small XML
 * parts (OOXML SpreadsheetML). Uses JSZip — already a dependency for reading
 * `.docx`/`.pptx`/`.xlsx` in `content/extract.ts` — instead of pulling in a
 * dedicated spreadsheet-writing library (the repo's dependency allowlist
 * forbids new deps without a test).
 *
 * Cells use INLINE strings (`t="inlineStr"` / `<is><t>`), never the
 * `sharedStrings.xml` table: that avoids an entire extra part and the
 * string-interning bookkeeping it requires, at the cost of (harmlessly)
 * repeating string bytes for repeated values — irrelevant at the sizes a
 * draft's tables produce.
 */

import JSZip from "jszip"

export type Sheet = { readonly name: string; readonly rows: readonly (readonly string[])[] }

const illegalSheetNameChars = /[[\]:*?/\\]/g
const maxSheetNameLength = 31

/** Excel sheet-name rules: no `[]:*?/\`, at most 31 chars, no duplicates. */
export function sanitizeSheetNames(names: readonly string[]): readonly string[] {
  const used = new Set<string>()
  return names.map((raw) => {
    const cleaned = raw.replace(illegalSheetNameChars, "").trim()
    const base = (cleaned.length === 0 ? "Sheet" : cleaned).slice(0, maxSheetNameLength)
    let candidate = base
    let suffix = 2
    while (used.has(candidate.toLowerCase())) {
      const tag = ` (${suffix})`
      candidate = `${base.slice(0, maxSheetNameLength - tag.length)}${tag}`
      suffix += 1
    }
    used.add(candidate.toLowerCase())
    return candidate
  })
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

// Accounting-friendly numeric detection: plain numbers, a leading `$`,
// thousands commas, and parenthesized negatives (`(1,234)` → -1234) all
// count, since those are exactly the shapes a T-account/schedule table emits.
function numericValue(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return null
  }
  const negative = /^\(.*\)$/.test(trimmed)
  const stripped = trimmed
    .replace(/^\(|\)$/g, "")
    .replace(/^\$/, "")
    .replace(/,/g, "")
  if (!/^-?\d+(\.\d+)?$/.test(stripped)) {
    return null
  }
  const value = Number(stripped)
  return negative ? -value : value
}

function columnLetter(index: number): string {
  let n = index
  let letters = ""
  while (n >= 0) {
    letters = String.fromCharCode((n % 26) + 65) + letters
    n = Math.floor(n / 26) - 1
  }
  return letters
}

function cellXml(columnIndex: number, rowNumber: number, value: string): string {
  const ref = `${columnLetter(columnIndex)}${rowNumber}`
  const numeric = numericValue(value)
  if (numeric !== null) {
    return `<c r="${ref}"><v>${numeric}</v></c>`
  }
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`
}

function worksheetXml(sheet: Sheet): string {
  const rows = sheet.rows
    .map((row, rowIndex) => {
      const cells = row.map((value, columnIndex) => cellXml(columnIndex, rowIndex + 1, value))
      return `<row r="${rowIndex + 1}">${cells.join("")}</row>`
    })
    .join("")
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rows}</sheetData></worksheet>`
  )
}

function contentTypesXml(sheetCount: number): string {
  const overrides = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("")
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    `${overrides}</Types>`
  )
}

const rootRelsXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>"

function workbookXml(names: readonly string[]): string {
  const sheets = names
    .map(
      (name, index) =>
        `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("")
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets}</sheets></workbook>`
  )
}

function workbookRelsXml(sheetCount: number): string {
  const rels = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join("")
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `${rels}</Relationships>`
  )
}

/** Builds a real, minimal `.xlsx` (one worksheet part per sheet, inline
 * strings, no sharedStrings table) that Excel and Numbers both open. */
export async function buildXlsx(sheets: readonly Sheet[]): Promise<Uint8Array> {
  const names = sanitizeSheetNames(sheets.map((sheet) => sheet.name))
  const zip = new JSZip()
  zip.file("[Content_Types].xml", contentTypesXml(sheets.length))
  zip.file("_rels/.rels", rootRelsXml)
  zip.file("xl/workbook.xml", workbookXml(names))
  zip.file("xl/_rels/workbook.xml.rels", workbookRelsXml(sheets.length))
  for (const [index, sheet] of sheets.entries()) {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet))
  }
  return zip.generateAsync({ type: "uint8array" })
}
