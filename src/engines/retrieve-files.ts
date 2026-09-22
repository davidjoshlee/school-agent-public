import { readFile, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"

import { parseVaultDocument } from "../store/vault.js"

export type ManifestEntry = {
  readonly title: string
  readonly type: string
  readonly dates: string
  readonly path: string
  readonly tokenEstimate: number
  readonly restricted: boolean
}

export type VaultText = {
  readonly content: string
  readonly restricted: boolean
}

export type SummaryRequest = {
  readonly provider: string
  readonly model: string
  readonly path: string
  readonly content: string
}

export function parseManifest(content: string): readonly ManifestEntry[] {
  return content
    .split("\n")
    .slice(2)
    .flatMap((line) => {
      const cells = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
      const [title, type, dates, path, tokens, restriction] = cells
      if (title === undefined || type === undefined || dates === undefined || path === undefined) {
        return []
      }
      const tokenEstimate = Number.parseInt(tokens ?? "0", 10)
      return [
        {
          title,
          type,
          dates,
          path,
          tokenEstimate: Number.isFinite(tokenEstimate) ? tokenEstimate : 0,
          restricted: restriction === "restricted",
        },
      ]
    })
}

export function selectEntries(
  entries: readonly ManifestEntry[],
  task: string,
): readonly ManifestEntry[] {
  return entries
    .map((entry) => ({ entry, score: keywordScore(entry, task) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path),
    )
    .map(({ entry }) => entry)
}

export function vaultRelativePath(courseRoot: string, vaultPath: string): string {
  const fullPath = resolve(courseRoot, vaultPath)
  const path = relative(courseRoot, fullPath)
  if (path === "" || path.startsWith("..")) {
    throw new RetrievalFilesError(`Manifest path escapes the course vault: ${vaultPath}`)
  }
  return path
}

export async function readVaultText(path: string): Promise<VaultText | null> {
  try {
    const parsed = parseVaultDocument(await readFile(path, "utf8"), path)
    return {
      content: parsed.content.trim(),
      restricted: parsed.frontmatter.redistribution === "restricted",
    }
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null
    }
    throw error
  }
}

export async function readSummary(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim()
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null
    }
    throw error
  }
}

export async function summaryFor(input: {
  readonly entry: ManifestEntry
  readonly courseRoot: string
  readonly model: string
  readonly summarize: (request: SummaryRequest) => Promise<string>
}): Promise<{ readonly path: string; readonly content: string } | null> {
  const path = vaultRelativePath(input.courseRoot, input.entry.path)
  const fullPath = resolve(input.courseRoot, path)
  const sidecarPath = `${fullPath}.summary.md`
  const cached = await readSummary(sidecarPath)
  if (cached !== null) {
    return { path: `${path}.summary.md`, content: cached }
  }
  const source = await readVaultText(fullPath)
  if (source === null) {
    return null
  }
  const summary = await input.summarize({
    provider: input.model.split("/", 1)[0] ?? "unknown",
    model: input.model,
    path,
    content: source.content,
  })
  await writeFile(sidecarPath, summary, "utf8")
  return { path: `${path}.summary.md`, content: summary }
}

class RetrievalFilesError extends Error {
  readonly name = "RetrievalFilesError"
}

function keywordScore(entry: ManifestEntry, task: string): number {
  const haystack = `${entry.title} ${entry.type} ${entry.dates} ${entry.path}`.toLowerCase()
  return task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2)
    .filter((word) => haystack.includes(word)).length
}
