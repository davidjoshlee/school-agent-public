import { createHash } from "node:crypto"

import { extractText, type TextExtraction } from "../content/extract.js"
import type { CanvasHttpClient } from "./http.js"

const bytesPerMegabyte = 1_024 * 1_024

export type CanvasFile = {
  readonly id: string
  readonly displayName: string
  readonly size: number
  readonly updatedAt: string
  readonly canvasUrl: string
  readonly downloadUrl?: string
  readonly contentType?: string
}

export type FileIndexRecord = {
  readonly canvasUrl: string
  readonly metadataHash: string
  readonly downloaded: boolean
  readonly extracted: boolean
  readonly degraded: boolean
}

export type FileAuditGap = {
  readonly canvasUrl: string
  readonly reason: "extraction_failed" | "oversize" | "no_download_url"
}

type ProcessedFile = {
  readonly status: "processed"
  readonly index: FileIndexRecord
  readonly extraction: TextExtraction
  readonly bytes: Uint8Array
  readonly gap: FileAuditGap | null
}

type SkippedFile = {
  readonly status: "skipped"
  readonly index: FileIndexRecord
  readonly reason: "unchanged"
}

type OversizeFile = {
  readonly status: "oversize"
  readonly index: FileIndexRecord
  readonly gap: FileAuditGap
}

type NoDownloadUrlFile = {
  readonly status: "no-download-url"
  readonly index: FileIndexRecord
  readonly gap: FileAuditGap
}

export type CanvasFileSyncResult = NoDownloadUrlFile | OversizeFile | ProcessedFile | SkippedFile

export type CanvasFileSyncInput = {
  readonly client: CanvasHttpClient
  readonly file: CanvasFile
  readonly maxSizeMB: number
  readonly previous?: FileIndexRecord
}

function metadataHash(file: CanvasFile): string {
  return createHash("sha256").update(`${file.size}:${file.updatedAt}`).digest("hex")
}

function indexRecord(
  file: CanvasFile,
  hash: string,
  extraction: TextExtraction | null,
): FileIndexRecord {
  return {
    canvasUrl: file.canvasUrl,
    metadataHash: hash,
    downloaded: extraction !== null,
    extracted: extraction?.extracted ?? false,
    degraded: extraction?.degraded ?? false,
  }
}

export async function syncCanvasFile(input: CanvasFileSyncInput): Promise<CanvasFileSyncResult> {
  const hash = metadataHash(input.file)
  if (input.previous?.metadataHash === hash) {
    return { status: "skipped", index: input.previous, reason: "unchanged" }
  }
  if (input.file.size > input.maxSizeMB * bytesPerMegabyte) {
    const gap = { canvasUrl: input.file.canvasUrl, reason: "oversize" } as const
    return { status: "oversize", index: indexRecord(input.file, hash, null), gap }
  }
  if (input.file.downloadUrl === undefined) {
    // Canvas has no pre-signed verifier `url` for this file. `/api/v1/files/:id/download`
    // 404s in production and must never be used (see the project's Key decisions — Files);
    // record a gap instead of attempting the dead route.
    const gap = { canvasUrl: input.file.canvasUrl, reason: "no_download_url" } as const
    return { status: "no-download-url", index: indexRecord(input.file, hash, null), gap }
  }
  const response = await input.client.download(input.file.downloadUrl)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const extraction = await extractText({
    bytes,
    contentType: response.headers.get("content-type") ?? input.file.contentType ?? null,
    filename: input.file.displayName,
  })
  const gap = extraction.degraded
    ? { canvasUrl: input.file.canvasUrl, reason: "extraction_failed" as const }
    : null
  return {
    status: "processed",
    index: indexRecord(input.file, hash, extraction),
    extraction,
    bytes,
    gap,
  }
}
