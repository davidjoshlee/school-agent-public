import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { runCli } from "../src/cli.js"

describe("school prep CLI", () => {
  it("rejects a bogus prep model through the models-check preflight before any generation", async () => {
    // Given: a recorded Gateway catalog and a config whose vault and index stay in a temporary directory.
    const root = await mkdtemp(join(tmpdir(), "school-agent-prep-cli-"))
    const configPath = join(root, "school.config.json")
    const catalogPath = join(root, "catalog.json")
    await writeFile(
      configPath,
      JSON.stringify({
        vault: { path: root, gitInit: false },
        index: { path: join(root, "index.db") },
      }),
      "utf8",
    )
    await writeFile(
      catalogPath,
      JSON.stringify({ models: [{ id: "anthropic/claude-3-7-sonnet", promptCaching: true }] }),
      "utf8",
    )
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      // When: the prep command receives a model that is absent from the catalog.
      const exitCode = await runCli([
        "--config",
        configPath,
        "prep",
        "STRAT 101",
        "--week",
        "1",
        "--model",
        "bogus/model",
        "--catalog",
        catalogPath,
      ])

      // Then: model validation blocks the command and identifies the registry key.
      expect(exitCode).toBe(1)
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("models.functions.prepBrief -> bogus/model"),
      )
    } finally {
      error.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports a course lookup failure that mentions both the Canvas id and course code forms", async () => {
    // Given: a config whose index has no courses at all.
    const root = await mkdtemp(join(tmpdir(), "school-agent-prep-cli-"))
    const configPath = join(root, "school.config.json")
    await writeFile(
      configPath,
      JSON.stringify({
        vault: { path: root, gitInit: false },
        index: { path: join(root, "index.db") },
      }),
      "utf8",
    )
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      // When: prep is invoked with a value that matches neither a Canvas id nor a course code.
      const exitCode = await runCli(["--config", configPath, "prep", "999999", "--week", "1"])

      // Then: the command fails with zero network, and the message accepts both forms.
      expect(exitCode).toBe(1)
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Course not found in index: 999999"),
      )
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Canvas course id and course code"),
      )
    } finally {
      error.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
