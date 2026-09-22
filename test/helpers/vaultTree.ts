import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Recursively enumerate a vault subtree and return a map of every Markdown and
 * JSON file (relative path → contents, sorted). This is the fixture snapshot
 * helper that `onboard.test.ts` used to inline for its "rebuilds the pilot
 * subtree identically" comparison.
 */
export async function vaultTree(root: string): Promise<Readonly<Record<string, string>>> {
  const entries = await readdir(root, { recursive: true })
  const files = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".md") || entry.endsWith(".json"))
      .sort()
      .map(async (entry) => [entry, await readFile(join(root, entry), "utf8")] as const),
  )
  return Object.fromEntries(files)
}
