import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"
import { z } from "zod"

const dependencyRecordSchema = z.record(z.string(), z.string())
const packageManifestSchema = z.object({
  dependencies: dependencyRecordSchema.default({}),
  devDependencies: dependencyRecordSchema.default({}),
})
const allowedDependencyNames = [
  "@biomejs/biome",
  "@types/node",
  "ai",
  "better-sqlite3",
  "commander",
  "gray-matter",
  "jszip",
  "mammoth",
  "msw",
  "pdfjs-dist",
  "turndown",
  "tsx",
  "typescript",
  "vitest",
  "zod",
] as const
const forbiddenDependencyNames = [
  "ink",
  "react",
  "next",
  "express",
  "hono",
  "telegraf",
  "sqlite-vec",
  "lancedb",
  "chromadb",
  "@xenova/transformers",
] as const

describe("dependency allowlist", () => {
  it("keeps production and development dependencies within the approved set", async () => {
    // Given: the project package manifest.
    const packageJsonUrl = new URL("../package.json", import.meta.url)
    const packageJson = await readFile(packageJsonUrl, "utf8")
    const manifest = packageManifestSchema.parse(JSON.parse(packageJson))

    // When: its direct dependency names are collected.
    const dependencyNames = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }).sort()

    // Then: only the approved packages are declared, and forbidden packages are absent.
    expect(dependencyNames).toEqual([...allowedDependencyNames].sort())
    for (const dependencyName of forbiddenDependencyNames) {
      expect(dependencyNames).not.toContain(dependencyName)
    }
  })
})
