import type { Dirent } from "node:fs"
import { readdir, readFile } from "node:fs/promises"

import { isEnoent } from "./errors.js"

/** Read a UTF-8 file, returning null when it does not exist. */
export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (error: unknown) {
    if (isEnoent(error)) return null
    throw error
  }
}

/** List a directory's entries, returning [] when it does not exist. */
export async function readDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error: unknown) {
    if (isEnoent(error)) return []
    throw error
  }
}
