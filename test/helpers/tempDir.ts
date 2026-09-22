import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach } from "vitest"

/**
 * Tracks every directory created by {@link temporaryDirectory} so the suite can
 * remove them after each test. This centralises the `mkdtemp(join(tmpdir(), ...))`
 * + afterEach cleanup scaffolding that several test files used to inline.
 */
const directories: string[] = []

/**
 * Create a fresh temporary directory under the OS tmpdir with a stable prefix.
 *
 * The directory is registered for cleanup and removed automatically after the
 * current test. Tests that need the directory for the whole `it` simply await
 * the returned path; tests that manage their own lifecycle may still remove it
 * themselves (removal is idempotent because it is forced).
 */
export async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  const pending = directories.splice(0)
  await Promise.all(pending.map((directory) => rm(directory, { recursive: true, force: true })))
})
