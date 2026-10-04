import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path"
import { z } from "zod"

import { hasErrorCode } from "../util/errors.js"
import { vaultLayout } from "./paths.js"
import { assertReadingSource, planReadingCopy, readingText } from "./reading-copy.js"

const stateSchema = z.object({
  destination: z.string(),
  updatedAt: z.string(),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  mtimes: z.record(z.string(), z.number()).default({}),
})

/** An applied Current export explicitly opts this vault into subsequent CLI refreshes. */
export async function refreshConfiguredReadingMirror(
  root: string,
  privatePaths: readonly string[] = [],
) {
  await safeParents(root, join(root, vaultLayout.metadata, vaultLayout.readingMirrorState))
  const prior = await optionalBytes(
    join(root, vaultLayout.metadata, vaultLayout.readingMirrorState),
  )
  if (prior === null) return null
  const state = stateSchema.parse(JSON.parse(prior.toString("utf8")))
  return refreshReadingMirror(root, state.destination, undefined, privatePaths)
}

/** Single-writer one-way mirror. State stays local; unexpected remote edits are recovered. */
export async function refreshReadingMirror(
  root: string,
  destination: string,
  progress?: (stage: string) => void,
  privatePaths: readonly string[] = [],
): Promise<{
  readonly path: string
  readonly updated: number
  readonly recovered: number
  readonly unchanged: number
}> {
  const plan = await planReadingCopy(root, destination, privatePaths)
  const metadata = join(plan.root, vaultLayout.metadata)
  await safeParents(plan.root, metadata)
  await mkdir(metadata, { recursive: true })
  const lock = join(metadata, vaultLayout.readingMirrorLock)
  try {
    await mkdir(lock)
  } catch (error) {
    if (hasErrorCode(error, "EEXIST"))
      throw new Error(
        "Reading mirror is locked; another refresh may be running. Review the local lock after a crash.",
      )
    throw error
  }
  try {
    const statePath = join(metadata, vaultLayout.readingMirrorState)
    const prior = await optionalBytes(statePath)
    progress?.("Reading mirror: loading local reading files.")
    const state = prior === null ? null : stateSchema.parse(JSON.parse(prior.toString("utf8")))
    if (state && state.destination !== plan.destination)
      throw new Error(
        "Mirror destination differs from the saved mapping; refusing to reroute automatically.",
      )
    const current = join(plan.destination, "Current")
    await safeParents(plan.destination, current)
    const contents = new Map<string, Buffer>()
    for (const file of plan.files) {
      await assertReadingSource(file.source, plan.root)
      const data = await readFile(file.source)
      const extension = extname(file.source).toLowerCase()
      contents.set(
        file.output,
        extension === vaultLayout.markdownExtension || extension === ".txt"
          ? Buffer.from(readingText(data.toString("utf8")))
          : data,
      )
    }
    contents.set(
      "00 READ ME.txt",
      Buffer.from(
        "School Agent Current reading copy\n\nRefreshed after successful local CLI writes or a manual refresh. Other local edits need a manual refresh or a separately verified scheduler. Drive must be running and online to upload. No edits flow back. Markdown is plain-text .md.txt; originals remain local. Credentials, metadata, hidden state, simulations, and old archives are excluded. Previous or edited copies are preserved under Recovered. This is not a remote CLI or a complete secret audit.\n",
      ),
    )
    // Preflight all paths before modifying anything; never adopt existing user files.
    progress?.("Reading mirror: checking Drive copy metadata.")
    const existing = new Map<string, boolean>()
    const cached = new Set<string>()
    const mtimes: Record<string, number> = {}
    for (const name of new Set([...contents.keys(), ...Object.keys(state?.files ?? {})])) {
      validateName(name)
      const target = join(current, name)
      await safeParents(plan.destination, target)
      try {
        const info = await lstat(target)
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error("Mirror path is not a regular file.")
        if (!state?.files[name])
          throw new Error(`Unowned file in Current: ${name}. Use a new empty destination instead.`)
        existing.set(name, true)
        const desired = contents.get(name)
        const previousTime = state?.mtimes[name]
        const sameTime =
          previousTime === undefined
            ? info.mtimeMs <= Date.parse(state?.updatedAt ?? "")
            : info.mtimeMs === previousTime
        if (
          info.isFile() &&
          desired &&
          state?.files[name] === hash(desired) &&
          info.size === desired.length &&
          sameTime
        ) {
          // Avoid downloading unchanged Drive placeholders merely to rehash their bytes.
          cached.add(name)
          mtimes[name] = info.mtimeMs
        }
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error
        existing.set(name, false)
      }
    }
    let updated = 0
    progress?.("Reading mirror: applying changed files.")
    let recovered = 0
    let unchanged = 0
    const hashes: Record<string, string> = {}
    const recovery = join(
      plan.destination,
      "Recovered",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    )
    for (const [name, old] of existing) {
      const data = contents.get(name)
      const target = join(current, name)
      if (data && cached.has(name)) {
        hashes[name] = hash(data)
        mtimes[name] = (await lstat(target)).mtimeMs
        unchanged++
        continue
      }
      if (old) {
        const backup = join(recovery, name)
        await safeParents(plan.destination, backup)
        await mkdir(dirname(backup), { recursive: true })
        await safeParents(plan.destination, target)
        await rename(target, backup)
        recovered++
      }
      if (data) {
        await safeParents(plan.destination, target)
        await mkdir(dirname(target), { recursive: true })
        // A Drive/user write after preflight must not be replaced by our output.
        await writeFile(target, data, { flag: "wx", mode: 0o600 })
        hashes[name] = hash(data)
        mtimes[name] = (await lstat(target)).mtimeMs
        updated++
      }
    }
    await replaceLocalState(
      statePath,
      Buffer.from(
        JSON.stringify(
          {
            destination: plan.destination,
            updatedAt: new Date().toISOString(),
            files: hashes,
            mtimes,
          },
          null,
          2,
        ),
      ),
    )
    return { path: current, updated, recovered, unchanged }
  } finally {
    await rmdir(lock)
  }
}

function hash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

function validateName(name: string): void {
  if (isAbsolute(name) || name.split(/[\\/]/).some((part) => part === ".." || part === ""))
    throw new Error("Unsafe path in reading-mirror state.")
}

async function optionalBytes(path: string): Promise<Buffer | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Mirror path is not a regular file; refusing to follow links.")
    return await readFile(path)
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null
    throw error
  }
}

async function safeParents(root: string, target: string): Promise<void> {
  const local = relative(root, target)
  validateName(local)
  let path = root
  for (const part of ["", ...local.split(sep)]) {
    if (part) path = join(path, part)
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error("Symlink in mirror paths; refusing to write.")
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error
    }
  }
}

async function replaceLocalState(path: string, data: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, data, { flag: "wx", mode: 0o600 })
  await rename(temporary, path)
}
