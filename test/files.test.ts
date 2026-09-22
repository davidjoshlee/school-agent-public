import { readdir, readFile } from "node:fs/promises"

import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"

import { type CanvasFile, syncCanvasFile } from "../src/canvas/files.js"
import { extractText } from "../src/content/extract.js"
import { server } from "./helpers/canvasMock.js"
import { client } from "./helpers/schoolConfig.js"

const fixtureRoot = new URL("./fixtures/files/", import.meta.url)

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(name, fixtureRoot)))
}

async function snapshot(name: string): Promise<string> {
  return (await readFile(new URL(`${name}.txt`, fixtureRoot), "utf8")).trim()
}

function file(
  id: string,
  name: string,
  size: number,
  updatedAt = "2026-08-25T00:00:00.000Z",
): CanvasFile {
  return {
    id,
    displayName: name,
    size,
    updatedAt,
    canvasUrl: `https://canvas.test/files/${id}`,
  }
}

describe("file extraction", () => {
  it("keeps the deprecated Canvas verifier query parameter out of source", async () => {
    // Given: every TypeScript source file in the project.
    const sourceRoot = new URL("../src/", import.meta.url)
    const sourcePaths = (await readdir(sourceRoot, { recursive: true })).filter((path) =>
      path.endsWith(".ts"),
    )

    // When: the source is parsed into one searchable text corpus.
    const source = await Promise.all(
      sourcePaths.map(async (path) => readFile(new URL(path, sourceRoot), "utf8")),
    )

    // Then: no code constructs the deprecated query parameter.
    expect(source.join("\n")).not.toContain("verifier=")
  })

  it.each([
    ["synthetic.pdf", "application/pdf"],
    ["synthetic.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["synthetic.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["synthetic.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ])("extracts the known text from the synthetic %s fixture", async (name, contentType) => {
    // Given: a deliberately authored office fixture and its committed ground truth.
    const bytes = await fixture(name)

    // When: its bytes cross the extractor boundary.
    const result = await extractText({ bytes, contentType, filename: name })

    // Then: the extracted text matches the known synthetic snapshot.
    expect(result).toEqual({ extracted: true, degraded: false, text: await snapshot(name) })
  })

  it.each([
    ["notes.txt", "text/plain", "Synthetic plain text", { extracted: true, degraded: false }],
    ["notes.md", "text/markdown", "# Synthetic markdown", { extracted: true, degraded: false }],
    ["notes.html", "text/html", "<h1>Synthetic HTML</h1>", { extracted: true, degraded: false }],
    ["diagram.png", "image/png", "raw bytes", { extracted: false, degraded: false }],
  ])(
    "handles %s with its supported-content policy",
    async (filename, contentType, body, expected) => {
      // Given: a non-office file at a supported extraction boundary.
      const bytes = new TextEncoder().encode(body)

      // When: the file is classified and processed.
      const result = await extractText({ bytes, contentType, filename })

      // Then: text-like files extract while binary files remain raw.
      expect(result).toMatchObject(expected)
    },
  )

  it.each(["synthetic-scanned.pdf", "corrupt.pdf"])(
    "degrades instead of throwing for %s",
    async (name) => {
      // Given: a file that cannot yield selectable PDF text.
      const bytes = await fixture(name)

      // When: extraction is attempted.
      const result = await extractText({ bytes, contentType: "application/pdf", filename: name })

      // Then: the caller receives a typed degraded result and can continue.
      expect(result.extracted).toBe(false)
      expect(result.degraded).toBe(true)
    },
  )

  it("degrades a legacy .xls (OLE binary) with an actionable message instead of returning empty", async () => {
    // Given: bytes carrying the OLE compound-file magic header, as a real binary .xls would.
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])

    // When: extraction is attempted against the legacy filename.
    const result = await extractText({
      bytes,
      contentType: "application/vnd.ms-excel",
      filename: "budget.xls",
    })

    // Then: it degrades with a clear, actionable message rather than silently emptying out.
    expect(result.extracted).toBe(false)
    expect(result.degraded).toBe(true)
    expect(result).toMatchObject({
      message:
        "Legacy .xls (binary) is not supported; convert to .xlsx or add it via `school ingest`.",
    })
  })

  it("degrades a mislabeled legacy .xls detected purely by its OLE magic bytes", async () => {
    // Given: OLE magic bytes with a misleading extension and no declared content-type.
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4])

    // When: extraction is attempted.
    const result = await extractText({ bytes, contentType: null, filename: "mystery.bin" })

    // Then: the magic-byte sniff still catches it and degrades rather than misclassifying as raw.
    expect(result).toMatchObject({ extracted: false, degraded: true })
  })
})

describe("Canvas file sync", () => {
  it("uses the Bearer HTTP core, extracts a downloaded file, and skips an unchanged rerun", async () => {
    // Given: an MSW Canvas download endpoint serving authored PDF bytes at the pre-signed url.
    const bytes = await fixture("synthetic.pdf")
    let downloads = 0
    server.use(
      http.get("https://canvas.test/files/17/download-verified", () => {
        downloads += 1
        return new HttpResponse(bytes, { headers: { "content-type": "application/pdf" } })
      }),
    )
    const current = {
      ...file("17", "synthetic.pdf", bytes.byteLength),
      downloadUrl: "https://canvas.test/files/17/download-verified",
    }

    // When: the same metadata is synced twice, with the first index record supplied to rerun.
    const first = await syncCanvasFile({ client: client(), file: current, maxSizeMB: 100 })
    const second = await syncCanvasFile({
      client: client(),
      file: current,
      maxSizeMB: 100,
      previous: first.index,
    })

    // Then: the download runs once, known text is preserved, and the rerun is skipped by metadata hash.
    expect(first.extraction).toEqual({
      extracted: true,
      degraded: false,
      text: await snapshot("synthetic.pdf"),
    })
    expect(second.status).toBe("skipped")
    expect(downloads).toBe(1)
  })

  it("records a gap and never fetches the dead /download route when a file has no pre-signed url", async () => {
    // Given: a file with no pre-signed `downloadUrl` and a live handler on the deprecated
    // /api/v1/files/:id/download route, which CLAUDE.md documents as 404ing in production.
    let downloads = 0
    server.use(
      http.get("https://canvas.test/api/v1/files/20/download", () => {
        downloads += 1
        return HttpResponse.error()
      }),
    )

    // When: sync is attempted for a file without a downloadUrl.
    const result = await syncCanvasFile({
      client: client(),
      file: file("20", "handout.pdf", 1_024),
      maxSizeMB: 100,
    })

    // Then: it records a no_download_url gap and never calls the dead route.
    expect(result.status).toBe("no-download-url")
    expect(result.gap).toEqual({
      canvasUrl: "https://canvas.test/files/20",
      reason: "no_download_url",
    })
    expect(downloads).toBe(0)
  })

  it("records an oversize Canvas URL without downloading it", async () => {
    // Given: a file whose Canvas metadata exceeds a one-megabyte policy.
    let downloads = 0
    server.use(
      http.get("https://canvas.test/api/v1/files/18/download", () => {
        downloads += 1
        return HttpResponse.error()
      }),
    )

    // When: sync applies the configured size guard.
    const result = await syncCanvasFile({
      client: client(),
      file: file("18", "lecture.mp4", 1_048_577),
      maxSizeMB: 1,
    })

    // Then: it records a gap with the Canvas URL and never invokes the download handler.
    expect(result.status).toBe("oversize")
    expect(result.gap).toEqual({
      canvasUrl: "https://canvas.test/files/18",
      reason: "oversize",
    })
    expect(downloads).toBe(0)
  })

  it("keeps the sync result when a scanned PDF degrades", async () => {
    // Given: Canvas serves an authored image-only/scanned PDF analogue at its pre-signed url.
    const bytes = await fixture("synthetic-scanned.pdf")
    server.use(
      http.get(
        "https://canvas.test/files/19/download-verified",
        () => new HttpResponse(bytes, { headers: { "content-type": "application/pdf" } }),
      ),
    )

    // When: the file is synced.
    const result = await syncCanvasFile({
      client: client(),
      file: {
        ...file("19", "synthetic-scanned.pdf", bytes.byteLength),
        downloadUrl: "https://canvas.test/files/19/download-verified",
      },
      maxSizeMB: 100,
    })

    // Then: sync completes and reports the degradation in its audit gap.
    expect(result.status).toBe("processed")
    expect(result.extraction.degraded).toBe(true)
    expect(result.gap).toEqual({
      canvasUrl: "https://canvas.test/files/19",
      reason: "extraction_failed",
    })
  })
})
