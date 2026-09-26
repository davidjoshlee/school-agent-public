import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { runCli } from "../../src/cli.js"
import { createSchoolIndex } from "../../src/store/db.js"

describe("school vault health CLI", () => {
  it("prints JSON dry-run results, returns nonzero for issues, and leaves the index unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "vault-health-cli-"))
    const vault = join(root, "vault")
    const indexPath = join(root, "index.db")
    const configPath = join(root, "school.config.json")
    await mkdir(join(vault, "course-101", "Week 1 - Sep 21"), { recursive: true })
    await mkdir(join(vault, "course-101", "Week 01 - Sep 28"), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({ vault: { path: vault, gitInit: false }, index: { path: indexPath } }),
      "utf8",
    )
    createSchoolIndex({ path: indexPath }).close()
    const before = await readFile(indexPath)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const exitCode = await runCli(["--config", configPath, "vault", "health", "--json"])
      expect(exitCode).toBe(1)
      const output = log.mock.calls.map((call) => String(call[0])).join("\n")
      expect(JSON.parse(output)).toMatchObject({
        dryRun: true,
        issues: [{ kind: "duplicate-week-directory" }],
      })
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Vault health found 1 issue"))
      expect(await readFile(indexPath)).toEqual(before)
    } finally {
      log.mockRestore()
      error.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
