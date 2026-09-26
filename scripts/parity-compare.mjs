#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import matter from "gray-matter"

async function courseRoots(vault) {
  const roots = new Map()
  for (const entry of await readdir(vault, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue
    const root = join(vault, entry.name)
    let index
    try {
      index = await readFile(join(root, "_index.md"), "utf8")
    } catch (error) {
      if (error?.code === "ENOENT") {
        // User-owned top-level folders are still part of parity. Match them by
        // name because they do not carry a stable Canvas identity.
        roots.set(`unindexed:${entry.name}`, root)
        continue
      }
      throw error
    }
    const id = String(matter(index).data.canvas_id ?? "")
    if (!id || !/^[A-Za-z0-9_-]+$/u.test(id)) {
      throw new Error(`Invalid Canvas identity in ${join(root, "_index.md")}`)
    }
    if (roots.has(id)) throw new Error(`Duplicate Canvas identity ${id} in ${vault}`)
    roots.set(id, root)
  }
  return roots
}

async function collectFiles(directory, base = directory, output = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symlink in course tree: ${path}`)
    if (entry.isDirectory()) {
      await collectFiles(path, base, output)
    } else if (entry.isFile()) {
      const bytes = await readFile(path)
      output.set(relative(base, path), createHash("sha256").update(bytes).digest("hex"))
    } else {
      throw new Error(`Unsupported course tree entry: ${path}`)
    }
  }
  return output
}

export async function compareCourseVaults(baselineVault, candidateVault) {
  const baseline = await courseRoots(resolve(baselineVault))
  const candidate = await courseRoots(resolve(candidateVault))
  const differences = []
  for (const id of new Set([...baseline.keys(), ...candidate.keys()])) {
    const left = baseline.get(id)
    const right = candidate.get(id)
    if (!left || !right) {
      differences.push({
        course: id,
        path: "",
        reason: left ? "candidate course missing" : "baseline course missing",
      })
      continue
    }
    const leftFiles = await collectFiles(left)
    const rightFiles = await collectFiles(right)
    for (const path of new Set([...leftFiles.keys(), ...rightFiles.keys()])) {
      if (leftFiles.get(path) !== rightFiles.get(path)) {
        differences.push({
          course: id,
          path,
          reason: !leftFiles.has(path)
            ? "candidate only"
            : !rightFiles.has(path)
              ? "baseline only"
              : "content differs",
        })
      }
    }
  }
  return differences.sort((a, b) => `${a.course}/${a.path}`.localeCompare(`${b.course}/${b.path}`))
}

async function main() {
  const [baseline, candidate] = process.argv.slice(2)
  if (!baseline || !candidate) {
    console.error(
      `Usage: node ${basename(process.argv[1] ?? "parity-compare.mjs")} BASELINE_VAULT CANDIDATE_VAULT`,
    )
    process.exitCode = 2
    return
  }
  const differences = await compareCourseVaults(baseline, candidate)
  console.log(JSON.stringify({ equal: differences.length === 0, differences }, null, 2))
  if (differences.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
