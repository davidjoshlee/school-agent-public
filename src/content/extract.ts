import JSZip from "jszip"
import mammoth from "mammoth"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import TurndownService from "turndown"

const textExtensions = new Set(["md", "markdown", "txt"])
const htmlExtensions = new Set(["htm", "html"])

type FileKind = "docx" | "html" | "pdf" | "pptx" | "raw" | "text" | "xlsx"

export type TextExtractionInput = {
  readonly bytes: Uint8Array
  readonly contentType: string | null
  readonly filename: string
}

export type ExtractedText = {
  readonly extracted: true
  readonly degraded: false
  readonly text: string
}

export type RawFile = {
  readonly extracted: false
  readonly degraded: false
  readonly text: null
}

export type DegradedFile = {
  readonly extracted: false
  readonly degraded: true
  readonly text: null
  readonly message: string
}

export type TextExtraction = DegradedFile | ExtractedText | RawFile

function fileExtension(filename: string): string {
  const extension = filename.split(".").at(-1)
  return extension === undefined ? "" : extension.toLowerCase()
}

function fileKind(input: TextExtractionInput): FileKind {
  const extension = fileExtension(input.filename)
  const contentType = input.contentType?.split(";", 1)[0]?.toLowerCase() ?? ""
  if (contentType === "application/pdf" || extension === "pdf") {
    return "pdf"
  }
  if (
    contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension === "docx"
  ) {
    return "docx"
  }
  if (
    contentType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    extension === "pptx"
  ) {
    return "pptx"
  }
  if (
    contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    extension === "xlsx"
  ) {
    return "xlsx"
  }
  if (contentType === "text/html" || htmlExtensions.has(extension)) {
    return "html"
  }
  if (contentType.startsWith("text/") || textExtensions.has(extension)) {
    return "text"
  }
  return "raw"
}

const oleMagic = [0xd0, 0xcf, 0x11, 0xe0]

function hasOleMagic(bytes: Uint8Array): boolean {
  return oleMagic.every((byte, index) => bytes[index] === byte)
}

function isLegacyXls(input: TextExtractionInput): boolean {
  const extension = fileExtension(input.filename)
  const contentType = input.contentType?.split(";", 1)[0]?.toLowerCase() ?? ""
  return (
    extension === "xls" || contentType === "application/vnd.ms-excel" || hasOleMagic(input.bytes)
  )
}

function decodedText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim()
}

function assertNever(value: never): never {
  throw new Error(`Unsupported file kind: ${value}`)
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true })
  try {
    const document = await task.promise
    const pages = await Promise.all(
      Array.from({ length: document.numPages }, async (_, index) => {
        const page = await document.getPage(index + 1)
        const text = await page.getTextContent()
        return text.items
          .flatMap((item) => ("str" in item && typeof item.str === "string" ? [item.str] : []))
          .join(" ")
          .trim()
      }),
    )
    const extracted = pages
      .filter((page) => page.length > 0)
      .join("\n")
      .trim()
    if (extracted.length === 0) {
      throw new ExtractionError("PDF has no selectable text")
    }
    return extracted
  } finally {
    await task.destroy()
  }
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value.trim()
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
}

async function extractPptx(bytes: Uint8Array): Promise<string> {
  const archive = await JSZip.loadAsync(bytes)
  const slides = archive
    .file(/^ppt\/slides\/slide\d+\.xml$/)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
  const extracted = await Promise.all(
    slides.map(async (slide) => {
      const xml = await slide.async("text")
      return Array.from(xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g), (match) =>
        unescapeXml(match[1] ?? ""),
      )
        .join(" ")
        .trim()
    }),
  )
  const text = extracted
    .filter((slide) => slide.length > 0)
    .join("\n")
    .trim()
  if (text.length === 0) {
    throw new ExtractionError("PPTX has no text nodes")
  }
  return text
}

async function parseSharedStrings(archive: JSZip): Promise<readonly string[]> {
  const file = archive.file("xl/sharedStrings.xml")
  if (!file) {
    return []
  }
  const xml = await file.async("text")
  return Array.from(xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g), (match) =>
    Array.from(match[1]?.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) ?? [], (run) =>
      unescapeXml(run[1] ?? ""),
    ).join(""),
  )
}

async function parseSheetNames(archive: JSZip): Promise<readonly string[]> {
  const file = archive.file("xl/workbook.xml")
  if (!file) {
    return []
  }
  const xml = await file.async("text")
  return Array.from(xml.matchAll(/<sheet\b([^>]*)\/>/g), (match) => {
    const name = match[1]?.match(/\bname="([^"]*)"/)
    return unescapeXml(name?.[1] ?? "")
  })
}

function cellValue(
  type: string | undefined,
  content: string,
  sharedStrings: readonly string[],
): string {
  if (type === "s") {
    const index = content.match(/<v>([\s\S]*?)<\/v>/)?.[1]
    const parsed = index === undefined ? Number.NaN : Number.parseInt(index, 10)
    return Number.isNaN(parsed) ? "" : (sharedStrings[parsed] ?? "")
  }
  if (type === "inlineStr") {
    return Array.from(content.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g), (match) =>
      unescapeXml(match[1] ?? ""),
    ).join("")
  }
  const raw = content.match(/<v>([\s\S]*?)<\/v>/)?.[1]
  return raw === undefined ? "" : unescapeXml(raw)
}

function extractRows(xml: string, sharedStrings: readonly string[]): string[] {
  const rows: string[] = []
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const cellMatch of rowMatch[1]?.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g) ?? []) {
      const content = cellMatch[2]
      if (content === undefined) {
        continue
      }
      const type = (cellMatch[1] ?? "").match(/\bt="([^"]*)"/)?.[1]
      const value = cellValue(type, content, sharedStrings)
      if (value.length > 0) {
        cells.push(value)
      }
    }
    if (cells.length > 0) {
      rows.push(cells.join(" | "))
    }
  }
  return rows
}

async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const archive = await JSZip.loadAsync(bytes)
  const sharedStrings = await parseSharedStrings(archive)
  const sheetNames = await parseSheetNames(archive)
  const sheets = archive
    .file(/^xl\/worksheets\/sheet\d+\.xml$/)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
  const rendered = await Promise.all(
    sheets.map(async (sheet, index) => {
      const xml = await sheet.async("text")
      const rows = extractRows(xml, sharedStrings)
      if (rows.length === 0) {
        return ""
      }
      const name = sheetNames[index] ?? `Sheet ${index + 1}`
      return `## ${name}\n${rows.join("\n")}`
    }),
  )
  const text = rendered
    .filter((sheet) => sheet.length > 0)
    .join("\n\n")
    .trim()
  if (text.length === 0) {
    throw new ExtractionError("XLSX has no cell data")
  }
  return text
}

class ExtractionError extends Error {
  readonly name = "ExtractionError"
}

async function extractSupportedText(
  kind: Exclude<FileKind, "raw">,
  bytes: Uint8Array,
): Promise<string> {
  switch (kind) {
    case "docx":
      return extractDocx(bytes)
    case "html":
      return new TurndownService().turndown(decodedText(bytes)).trim()
    case "pdf":
      return extractPdf(bytes)
    case "pptx":
      return extractPptx(bytes)
    case "text":
      return decodedText(bytes)
    case "xlsx":
      return extractXlsx(bytes)
    default:
      return assertNever(kind)
  }
}

function degraded(message: string): DegradedFile {
  return { extracted: false, degraded: true, text: null, message }
}

export async function extractText(input: TextExtractionInput): Promise<TextExtraction> {
  if (isLegacyXls(input)) {
    return degraded(
      "Legacy .xls (binary) is not supported; convert to .xlsx or add it via `school ingest`.",
    )
  }
  const kind = fileKind(input)
  if (kind === "raw") {
    return { extracted: false, degraded: false, text: null }
  }
  try {
    const text = await extractSupportedText(kind, input.bytes)
    if (text.length === 0) {
      return degraded("Extractor returned no text")
    }
    return { extracted: true, degraded: false, text }
  } catch (error) {
    if (error instanceof Error) {
      return degraded(error.message)
    }
    return degraded("Extractor threw a non-Error value")
  }
}
