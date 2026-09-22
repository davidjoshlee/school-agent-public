import { readdir, readFile } from "node:fs/promises"
import { basename, join, relative, sep } from "node:path"

import type { SchoolConfig } from "../config/index.js"
import { vaultDocumentKinds, vaultLayout } from "./paths.js"
import {
  parseVaultDocument,
  type VaultFrontmatter,
  vaultAiPolicies,
  vaultRedistribution,
} from "./vault-document.js"

const dateSignals = ["unlock_at", "posted_at", "created_at", "due_at"] as const
const manifestHeader = [
  "| Title | Type | Dates | Path | Tokens | Restriction |",
  "| --- | --- | --- | --- | ---: | --- |",
] as const

type ManifestBuildInput = {
  readonly courseRoot: string
  readonly indexPath: string
  readonly restrictedFileHandling: SchoolConfig["restrictedFileHandling"]
  readonly activeAssignmentIds?: readonly string[]
}

type ManifestRow = {
  readonly title: string
  readonly type: string
  readonly date: string
  readonly path: string
  readonly tokenEstimate: number
  readonly restriction: "allowed" | "restricted"
}

export async function buildCourseManifest(input: ManifestBuildInput): Promise<string> {
  const activeAssignmentIds =
    input.activeAssignmentIds === undefined ? undefined : new Set(input.activeAssignmentIds)
  const paths = (await markdownFiles(input.courseRoot))
    .filter((path) => path !== input.indexPath)
    .filter((path) => !path.endsWith(vaultLayout.feedback))
    .filter((path) => !path.endsWith(`.summary${vaultLayout.markdownExtension}`))
    .sort()
  const rows = await Promise.all(
    paths.map(async (path): Promise<ManifestRow | null> => {
      // A single malformed vault document (e.g. a hand-authored guidance file
      // missing frontmatter) must not abort the whole sync's manifest rebuild:
      // skip it with a warning and keep the rest of the course intact.
      let document: ReturnType<typeof parseVaultDocument>
      try {
        document = parseVaultDocument(await readFile(path, "utf8"), path)
      } catch (error: unknown) {
        console.warn(
          `Skipping unparseable vault document ${path}: ${error instanceof Error ? error.message : String(error)}`,
        )
        return null
      }
      if (
        document.frontmatter.type === vaultDocumentKinds.assignment &&
        activeAssignmentIds !== undefined &&
        !activeAssignmentIds.has(document.frontmatter.canvas_id)
      ) {
        return null
      }
      const vaultPath = relative(input.courseRoot, path).split(sep).join("/")
      return {
        title: titleFromPath(vaultPath),
        type: document.frontmatter.type,
        date: displayDate(document.frontmatter.dates),
        path: vaultPath,
        tokenEstimate: Math.ceil(document.content.length / 4),
        restriction: manifestRestriction(document.frontmatter, input.restrictedFileHandling),
      }
    }),
  )
  return [
    ...manifestHeader,
    ...rows.flatMap((row) =>
      row === null
        ? []
        : [
            `| ${row.title} | ${row.type} | ${row.date} | ${row.path} | ${row.tokenEstimate} | ${row.restriction} |`,
          ],
    ),
  ].join("\n")
}

async function markdownFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return markdownFiles(path)
      return Promise.resolve(
        entry.isFile() && entry.name.endsWith(vaultLayout.markdownExtension) ? [path] : [],
      )
    }),
  )
  return paths.flat()
}

function titleFromPath(path: string): string {
  const slug = basename(path, vaultLayout.markdownExtension).replace(/^\d+-/, "")
  const title = slug.replaceAll("-", " ")
  const first = title[0]
  return first === undefined ? title : `${first.toUpperCase()}${title.slice(1)}`
}

function displayDate(dates: Readonly<Record<string, string | null>>): string {
  for (const signal of dateSignals) {
    const value = dates[signal]
    if (value !== undefined && value !== null && Number.isFinite(Date.parse(value))) {
      return value.slice(0, 10)
    }
  }
  return "unknown"
}

function manifestRestriction(
  frontmatter: VaultFrontmatter,
  handling: SchoolConfig["restrictedFileHandling"],
): ManifestRow["restriction"] {
  const restricted =
    frontmatter.redistribution === vaultRedistribution.restricted ||
    frontmatter.ai_policy === vaultAiPolicies.prohibited
  return restricted && handling !== "allow" ? "restricted" : "allowed"
}
