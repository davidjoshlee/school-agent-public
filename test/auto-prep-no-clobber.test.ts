import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import { vaultDocumentKinds } from "../src/store/paths.js"
import { VaultWriter } from "../src/store/vault.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

describe("unattended prep atomic no-clobber", () => {
  it("skips a second write to the same target without changing the first artifact", async () => {
    const root = await temporaryDirectory("auto-prep-write-")
    const writer = new VaultWriter({ root, gitInit: false })
    const input = {
      course: {
        code: "DEMO-101",
        canvasId: "101",
        canvasUrl: "https://canvas.example.invalid/courses/101",
        aiPolicy: "allowed" as const,
      },
      kind: vaultDocumentKinds.prep,
      title: "week 2026-10-05",
      canvasId: "prep-week-2026-10-05",
      canvasUrl: "https://canvas.example.invalid/courses/101",
      content: "First version",
      source: "agent" as const,
      status: "auto-final" as const,
      period: { kind: "week" as const, number: 3, title: "Oct 05" },
      preserveExisting: true,
    }
    const first = await writer.write(input)
    const before = await readFile(first.path, "utf8")
    const second = await writer.write({ ...input, content: "Would overwrite" })
    expect(first.kind).toBe("written")
    expect(second.kind).toBe("skipped")
    expect(await readFile(first.path, "utf8")).toBe(before)
  })
})
