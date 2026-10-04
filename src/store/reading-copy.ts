import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { hasErrorCode } from "../util/errors.js"
import { vaultLayout } from "./paths.js"

const formats = new Set([
  vaultLayout.markdownExtension,
  ".txt",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".mp3",
  ".m4a",
  ".mp4",
  ".mov",
])

export type ReadingCopyPlan = {
  readonly root: string
  readonly destination: string
  readonly files: readonly {
    readonly source: string
    readonly output: string
    readonly bytes: number
  }[]
  readonly skipped: number
  readonly totalBytes: number
}

/** One-way, append-only reading snapshots. No source or existing destination file is mutated. */
export async function planReadingCopy(
  rootPath: string,
  destinationPath: string,
  privatePaths: readonly string[] = [],
): Promise<ReadingCopyPlan> {
  const root = await realpath(resolve(rootPath))
  for (const privatePath of privatePaths) {
    if (inside(await canonicalPath(resolve(privatePath)), root)) {
      throw new Error(
        "Configured credentials, configuration, or index path is inside the vault; reading export refused.",
      )
    }
  }
  const destination = await canonicalPath(resolve(destinationPath))
  if (inside(destination, root) || inside(root, destination)) {
    throw new Error(
      "Reading-copy destination must be separate from the working vault, not its parent or child.",
    )
  }
  const files: { source: string; output: string; bytes: number }[] = []
  let skipped = 0
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const source = join(directory, name)
      const info = await lstat(source)
      if (
        info.isSymbolicLink() ||
        name.startsWith(".") ||
        [vaultLayout.metadata, "old", "_simulations"].includes(name.toLowerCase()) ||
        name === vaultLayout.index ||
        name === vaultLayout.obsidianGuide
      ) {
        skipped += 1
        continue
      }
      if (info.isDirectory()) {
        await visit(source)
      } else if (info.isFile() && formats.has(extname(name).toLowerCase())) {
        const local = relative(root, source)
        files.push({
          source,
          output:
            extname(name).toLowerCase() === vaultLayout.markdownExtension ? `${local}.txt` : local,
          bytes: info.size,
        })
      } else skipped += 1
    }
  }
  await visit(root)
  const outputNames = new Set(["00 read me.txt"])
  for (const file of files) {
    const key = file.output.normalize("NFC").toLowerCase()
    if (outputNames.has(key))
      throw new Error(
        "Reading-copy filenames collide; rename the conflicting local reading files before exporting.",
      )
    outputNames.add(key)
  }
  return {
    root,
    destination,
    files,
    skipped,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  }
}

export async function createReadingCopy(
  root: string,
  destination: string,
  privatePaths: readonly string[] = [],
): Promise<{ readonly path: string; readonly copied: number; readonly skipped: number }> {
  const plan = await planReadingCopy(root, destination, privatePaths)
  // A unique new folder means no remote edit or previous snapshot can be overwritten.
  const folder = `Reading ${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
  const path = join(plan.destination, folder)
  await mkdir(plan.destination, { recursive: true })
  await mkdir(path)
  for (const file of plan.files) {
    await assertReadingSource(file.source, plan.root)
    const data = await readFile(file.source)
    const extension = extname(file.source).toLowerCase()
    const content =
      extension === vaultLayout.markdownExtension || extension === ".txt"
        ? readingText(data.toString("utf8"))
        : data
    const target = join(path, file.output)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, { flag: "wx" })
  }
  // Written last: absence of this file means the snapshot did not complete.
  await writeFile(
    join(path, "00 READ ME.txt"),
    `School Agent reading copy\n\nSnapshot created: ${new Date().toISOString()}\nFiles: ${plan.files.length}\n\nOpen this folder in the Google Drive app on your iPhone. Markdown notes are .md.txt for text preview; PDFs and Office originals retain their formats. Text copies omit frontmatter and redact known signed-link query parameters. This is not a complete content/secret audit.\n\nThis is a one-way snapshot, not a live Obsidian vault or remote CLI. Changes here never flow back. Run vault reading-copy again for a new dated snapshot; existing snapshots are preserved, including files since removed from the working vault.\n\nHidden folders, metadata, simulations, old archives, manifests, and unsupported file types were excluded. Credentials and the working database stay local.\n`,
    { flag: "wx" },
  )
  return { path, copied: plan.files.length, skipped: plan.skipped }
}

export function readingText(content: string): string {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(
      /([?&](?:verifier|access_token|token|sig|signature|X-Amz-Signature|X-Goog-Signature)=)[^\s&<>"')]+/gi,
      "$1[redacted]",
    )
}

/** Recheck source containment after planning, including changed ancestor links. */
export async function assertReadingSource(path: string, root: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || !inside(await realpath(path), root)) {
    throw new Error(
      "Source changed or escaped the vault during export; reading copy is incomplete.",
    )
  }
}

function inside(path: string, root: string): boolean {
  const local = relative(root, path)
  return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local))
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error
    const parent = dirname(path)
    if (parent === path) return path
    return join(await canonicalPath(parent), relative(parent, path))
  }
}
