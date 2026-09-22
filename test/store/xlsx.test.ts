import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { buildXlsx, sanitizeSheetNames } from "../../src/store/xlsx.js"
import {
  extractComputationsSheet,
  extractTables,
  sheetsFromDraft,
} from "../../src/store/xlsx-extract.js"

async function sheetXml(archive: JSZip, index: number): Promise<string> {
  const file = archive.file(`xl/worksheets/sheet${index}.xml`)
  if (file === null) {
    throw new Error(`sheet${index}.xml missing from archive`)
  }
  return file.async("text")
}

describe("buildXlsx", () => {
  it("produces a valid archive with the required OOXML parts", async () => {
    // Given: a two-sheet workbook.
    const bytes = await buildXlsx([
      {
        name: "Cash",
        rows: [
          ["Debit", "Credit"],
          ["100", "50"],
        ],
      },
      {
        name: "Inventory",
        rows: [
          ["Debit", "Credit"],
          ["20", "5"],
        ],
      },
    ])

    // When: the bytes are unzipped.
    const archive = await JSZip.loadAsync(bytes)

    // Then: every required OOXML part is present, and each sheet holds its cells.
    expect(archive.file("[Content_Types].xml")).not.toBeNull()
    expect(archive.file("_rels/.rels")).not.toBeNull()
    expect(archive.file("xl/workbook.xml")).not.toBeNull()
    expect(archive.file("xl/_rels/workbook.xml.rels")).not.toBeNull()
    const workbookXml = await archive.file("xl/workbook.xml")?.async("text")
    expect(workbookXml).toContain('name="Cash"')
    expect(workbookXml).toContain('name="Inventory"')
    const sheet1 = await sheetXml(archive, 1)
    expect(sheet1).toContain("Debit")
    expect(sheet1).toContain("<v>100</v>")
    const sheet2 = await sheetXml(archive, 2)
    expect(sheet2).toContain("<v>20</v>")
  })

  it("writes a numeric-looking cell as a number and a text cell as an inline string", async () => {
    // Given: a sheet mixing a plain number with text.
    const bytes = await buildXlsx([{ name: "Sheet1", rows: [["Label", "42"]] }])

    // When: read back.
    const xml = await sheetXml(await JSZip.loadAsync(bytes), 1)

    // Then: the number carries no inlineStr type and a bare <v>; the text does.
    expect(xml).toMatch(/<c r="A1" t="inlineStr"><is><t>Label<\/t><\/is><\/c>/)
    expect(xml).toMatch(/<c r="B1"><v>42<\/v><\/c>/)
    expect(xml).not.toContain('t="inlineStr"><is><t>42')
  })

  it("round-trips XML-unsafe characters safely", async () => {
    // Given: a cell value containing &, <, and ".
    const value = 'Tom & Jerry <ok> "quoted"'
    const bytes = await buildXlsx([{ name: "Sheet1", rows: [[value]] }])

    // When: unzipped and parsed back out.
    const archive = await JSZip.loadAsync(bytes)
    const xml = await sheetXml(archive, 1)

    // Then: the raw special characters never appear unescaped in the XML...
    expect(xml).not.toContain("Tom & Jerry <ok>")
    // ...and the escaped form decodes back to the original value.
    const inline = /<t>([\s\S]*?)<\/t>/.exec(xml)?.[1] ?? ""
    const decoded = inline
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
    expect(decoded).toBe(value)
  })

  it("sanitizes and de-duplicates sheet names", () => {
    // Given: names with illegal characters, an over-length name, and a duplicate.
    const names = ["Trial [Balance]", "a".repeat(40), "Cash", "Cash", "Sched:ule*/Q1\\Q2?"]

    // When: sanitized.
    const result = sanitizeSheetNames(names)

    // Then: illegal chars are gone, names are <=31 chars, and duplicates are disambiguated.
    for (const name of result) {
      expect(name.length).toBeLessThanOrEqual(31)
      expect(name).not.toMatch(/[[\]:*?/\\]/)
    }
    expect(new Set(result.map((name) => name.toLowerCase())).size).toBe(result.length)
    expect(result[1]).toBe("a".repeat(31))
    expect(result[2]).toBe("Cash")
    expect(result[3]).not.toBe("Cash")
  })
})

describe("sheetsFromDraft", () => {
  const draft = [
    "# Draft",
    "",
    "## Cash T-account",
    "",
    "| Debit | Credit |",
    "| --- | --- |",
    "| 100 | 50 |",
    "",
    "## Inventory T-account",
    "",
    "| Debit | Credit |",
    "| --- | --- |",
    "| 20 | 5 |",
    "",
    "## Computations",
    "",
    "- ending cash — 50",
    "- ending inventory — 15",
    "",
    "## Correctness check",
    "- Verified.",
  ].join("\n")

  it("extracts one sheet per Markdown table, named after the nearest heading", () => {
    // When: tables are extracted from the draft.
    const tables = extractTables(draft)

    // Then: two tables, correctly named and with their rows.
    expect(tables.map((table) => table.name)).toEqual(["Cash T-account", "Inventory T-account"])
    expect(tables[0]?.rows).toEqual([
      ["Debit", "Credit"],
      ["100", "50"],
    ])
  })

  it("extracts a Computations sheet from the ## Computations section", () => {
    // When: the computations sheet is extracted.
    const sheet = extractComputationsSheet(draft)

    // Then: it has a header row and one row per computation line, stopping at the next heading.
    expect(sheet?.rows).toEqual([
      ["Label", "Value"],
      ["ending cash", "50"],
      ["ending inventory", "15"],
    ])
  })

  it("yields three sheets total for a draft with two tables and a Computations section", () => {
    // When: the full extraction runs.
    const sheets = sheetsFromDraft(draft)

    // Then: two table sheets plus the Computations sheet, in that order.
    expect(sheets.map((sheet) => sheet.name)).toEqual([
      "Cash T-account",
      "Inventory T-account",
      "Computations",
    ])
  })

  it("yields no sheets for a draft with no tables and no computations", () => {
    // Given: a plain prose draft.
    const prose = "# Draft\n\nJust prose, no tables, no computations here."

    // Then: extraction yields nothing to write.
    expect(sheetsFromDraft(prose)).toEqual([])
  })
})

describe("extractTables sheet naming", () => {
  it("names each sheet from its own preceding heading, even when a data row is present", () => {
    // Given: `tabularOutputDirective` requires the model to give every table
    // its own heading naming what it is — verify that heading wins as the
    // PRIMARY rule (not merely a fallback when a table happens to lack data).
    const draft = [
      "#### Cash",
      "",
      "| Ref | Description | Debit | Credit |",
      "| --- | --- | --- | --- |",
      "| (1) | Stock Issuance | 26.00 | |",
      "",
      "#### Accounts Receivable",
      "",
      "| Ref | Description | Debit | Credit |",
      "| --- | --- | --- | --- |",
      "| (2) | Sale on account | 4.00 | |",
    ].join("\n")

    // When: tables are extracted.
    const tables = extractTables(draft)

    // Then: each table is named for its own heading, not any cell content.
    expect(tables.map((table) => table.name)).toEqual(["Cash", "Accounts Receivable"])
  })

  it("prefers a distinctive header cell when a table has no preceding heading", () => {
    // Given: a table with no heading above it at all, but a header cell that
    // isn't a generic column-role word.
    const draft = ["| Cash ($M) | Debit | Credit |", "| --- | --- | --- |", "| 10 | 5 |"].join("\n")

    // Then: the distinctive header cell names the sheet.
    expect(extractTables(draft).map((table) => table.name)).toEqual(["Cash ($M)"])
  })

  it("falls back to Table N when there is neither a heading nor a distinctive header cell", () => {
    // Given: a table with no preceding heading and only generic header cells.
    const draft = ["| Debit | Credit |", "| --- | --- |", "| 100 | 50 |"].join("\n")

    // Then: the positional fallback name is used.
    expect(extractTables(draft).map((table) => table.name)).toEqual(["Table 1"])
  })
})

describe("end-to-end: a bare numeric table cell survives extraction into a real number", () => {
  it("emits a plain '26.00' data cell (not the prose it was extracted alongside) as a numeric cell", async () => {
    // Given: a spreadsheet-shaped draft table — per the strengthened
    // tabularOutputDirective, the index/description live in their own
    // columns and the Debit cell holds ONLY the bare number.
    const draft = [
      "## Cash",
      "",
      "| Ref | Description | Debit | Credit |",
      "| --- | --- | --- | --- |",
      "| 1 | Stock Issuance | 26.00 | |",
    ].join("\n")

    // When: the table is extracted and built into a real workbook.
    const sheets = sheetsFromDraft(draft)
    const bytes = await buildXlsx(sheets)
    const archive = await JSZip.loadAsync(bytes)
    const xml = await sheetXml(archive, 1)

    // Then: the Debit cell is a bare numeric cell, not inline-string prose.
    expect(xml).toMatch(/<c r="C2"><v>26<\/v><\/c>/)
    expect(xml).not.toContain("Stock Issuance: $26.00")
  })
})
