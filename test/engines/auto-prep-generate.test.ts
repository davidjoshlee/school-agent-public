import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { loadConfig } from "../../src/config/index.js"
import { hasExistingWeeklyPrep } from "../../src/engines/auto-prep-generate.js"
import { coursePaths } from "../../src/store/paths.js"
import { createVaultFrontmatter, renderVaultDocument } from "../../src/store/vault-document.js"
import { temporaryDirectory } from "../helpers/tempDir.js"

describe("unattended prep overwrite guard", () => {
  it("recognizes an existing weekly brief in the matching course only", async () => {
    const root = await temporaryDirectory("auto-prep-existing-")
    const configPath = join(root, "school.config.json")
    const vaultRoot = join(root, "vault")
    await writeFile(
      configPath,
      JSON.stringify({ vault: { path: vaultRoot }, index: { path: join(root, "index.db") } }),
    )
    const config = loadConfig(configPath)
    const courseRoot = coursePaths(vaultRoot, "", "101").root
    const prepDir = join(courseRoot, "Week 03 - Oct 05", "Prep")
    await mkdir(prepDir, { recursive: true })
    const content = "# Synthetic prep\n"
    await writeFile(
      join(prepDir, "Prep.md"),
      renderVaultDocument(
        createVaultFrontmatter({
          canvasId: "prep-week-2026-10-05",
          canvasUrl: "https://canvas.example.invalid/courses/101",
          type: "prep",
          content,
          source: "agent",
          status: "auto-final",
          aiPolicy: "allowed",
        }),
        content,
      ),
    )
    expect(await hasExistingWeeklyPrep(config, "101", "2026-10-05")).toBe(true)
    expect(await hasExistingWeeklyPrep(config, "202", "2026-10-05")).toBe(false)
    expect(await hasExistingWeeklyPrep(config, "101", "2026-10-12")).toBe(false)
  })

  it("protects plain user Markdown in the selected week's Prep folder", async () => {
    const root = await temporaryDirectory("auto-prep-user-file-")
    const configPath = join(root, "school.config.json")
    const vaultRoot = join(root, "vault")
    await writeFile(
      configPath,
      JSON.stringify({ vault: { path: vaultRoot }, index: { path: join(root, "index.db") } }),
    )
    const config = loadConfig(configPath)
    const weekRoot = join(coursePaths(vaultRoot, "", "101").root, "Week 03 - Oct 05")
    const prepDir = join(weekRoot, "Prep")
    await mkdir(prepDir, { recursive: true })
    const content = "Week 3\n"
    await writeFile(
      join(weekRoot, "00 Overview.md"),
      renderVaultDocument(
        createVaultFrontmatter({
          canvasId: "module-3",
          canvasUrl: "https://canvas.example.invalid/courses/101/modules/3",
          type: "modules",
          content,
          dates: { session_at: "2026-10-05T17:00:00Z" },
          source: "sync",
          status: "final",
          aiPolicy: "allowed",
        }),
        content,
      ),
    )
    await writeFile(join(prepDir, "week 2026-10-05.md"), "My personal prep notes\n")
    expect(await hasExistingWeeklyPrep(config, "101", "2026-10-05")).toBe(true)
  })
})
