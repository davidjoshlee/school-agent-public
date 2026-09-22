import { readdir, readFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"

import type { Command } from "commander"

import type { RootOptions } from "../cli.js"
import { loadConfig } from "../config/index.js"
import { extractText } from "../content/extract.js"
import { slugify, vaultDocumentKinds, vaultLayout } from "../store/paths.js"
import { parseVaultDocument, VaultWriter, vaultSources, vaultStatuses } from "../store/vault.js"

type IngestOptions = {
  readonly course?: string
  readonly title?: string
  readonly asOf?: string
  readonly module?: string
}

type IngestCourse = {
  readonly code: string
  readonly canvasId: string
  readonly canvasUrl: string
  readonly aiPolicy: "allowed" | "prohibited"
}

export class IngestCommandError extends Error {
  readonly name = "IngestCommandError"
}

export function registerIngestCommand(program: Command): void {
  const ingest = program
    .command("ingest <file>")
    .description("Bring an off-Canvas local file into a course's vault as a dated files/ artifact")
  ingest.option("--course <canvas-id>", "target course's Canvas id (defaults to the pilot course)")
  ingest.option("--title <name>", "artifact title (defaults to the file's basename)")
  ingest.option("--as-of <iso-date>", "created_at date for the as-of clock (defaults to today)")
  ingest.option(
    "--module <canvas-id>",
    "module canvas id to link this file to (durable module_canvas_id frontmatter, makes it reachable by module-structured retrieval)",
  )
  ingest.action(async (file: string) => {
    const root = program.opts<RootOptions>()
    const options = ingest.opts<IngestOptions>()
    const configuration = loadConfig(root.config)
    const requestedCourseId = options.course ?? configuration.courses.pilotCourseId ?? undefined
    if (requestedCourseId === undefined) {
      throw new IngestCommandError(
        "No course specified. Pass --course <canvas-id> or configure courses.pilotCourseId.",
      )
    }
    const course = await findVaultCourse(configuration.vault.path, requestedCourseId)
    if (course === null) {
      throw new IngestCommandError(
        `Course not found in the vault: ${requestedCourseId}. Sync or onboard the course first.`,
      )
    }
    const title = options.title ?? basename(file, extname(file))
    const asOf = options.asOf ?? new Date().toISOString().slice(0, 10)
    const bytes = await readFile(file)
    const extraction = await extractText({
      bytes: new Uint8Array(bytes),
      contentType: null,
      filename: basename(file),
    })
    if (extraction.degraded) {
      throw new IngestCommandError(`Could not extract text from ${file}: ${extraction.message}`)
    }
    if (!extraction.extracted) {
      throw new IngestCommandError(
        `Unsupported file type for ${file}: no extractable text was found.`,
      )
    }
    const writer = new VaultWriter({
      root: configuration.vault.path,
      gitInit: configuration.vault.gitInit,
      warn: (message) => console.warn(message),
    })
    const result = await writer.write({
      course,
      kind: vaultDocumentKinds.file,
      title,
      canvasId: `manual-${slugify(title, "untitled")}`,
      canvasUrl: course.canvasUrl,
      content: extraction.text,
      dates: { created_at: asOf },
      source: vaultSources.user,
      status: vaultStatuses.final,
      redistribution: "allowed",
      ...(options.module === undefined ? {} : { moduleCanvasId: options.module }),
    })
    await writer.writeCourseManifest({
      course,
      restrictedFileHandling: configuration.restrictedFileHandling,
    })
    console.log(result.path)
  })
}

async function findVaultCourse(vaultRoot: string, canvasId: string): Promise<IngestCourse | null> {
  let entries: readonly { readonly name: string; readonly isDirectory: () => boolean }[]
  try {
    entries = await readdir(vaultRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue
    const indexPath = join(vaultRoot, entry.name, vaultLayout.index)
    try {
      const raw = await readFile(indexPath, "utf8")
      const parsed = parseVaultDocument(raw, indexPath)
      if (parsed.frontmatter.canvas_id !== canvasId) continue
      return {
        code: entry.name,
        canvasId: parsed.frontmatter.canvas_id,
        canvasUrl: parsed.frontmatter.canvas_url,
        aiPolicy: parsed.frontmatter.ai_policy,
      }
    } catch {
      // unreadable course index: skip it
    }
  }
  return null
}
