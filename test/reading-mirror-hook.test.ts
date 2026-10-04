import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"
import {
  refreshConfiguredReadingMirror,
  refreshReadingMirror,
} from "../src/store/reading-mirror.js"
import { registerReadingMirrorHook } from "../src/store/reading-mirror-hook.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

describe("CLI reading-copy refresh", () => {
  it("blocks automatic refresh when configuration changes to a private in-vault index", async () => {
    const base = await temporaryDirectory("school-hook-private-")
    const root = join(base, "vault")
    const destination = join(base, "drive")
    const config = join(base, "config.txt")
    await mkdir(root)
    await writeFile(join(root, "note.md"), "before")
    const mirror = await refreshReadingMirror(root, destination)
    const index = join(root, "index.txt")
    await writeFile(index, "synthetic private index")
    await writeFile(config, JSON.stringify({ vault: { path: root }, index: { path: index } }))
    const program = new Command().option("--config <path>", "configuration", config)
    program.command("prep").action(async () => {
      await writeFile(join(root, "note.md"), "after")
    })
    registerReadingMirrorHook(program)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await program.parseAsync(["prep"], { from: "user" })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("local work succeeded"))
      expect(await readFile(join(mirror.path, "note.md.txt"), "utf8")).toBe("before")
      expect(await readdir(mirror.path)).not.toContain("index.txt")
    } finally {
      warn.mockRestore()
    }
  })
  it("requires an existing applied mapping and refreshes after successful writers only", async () => {
    const base = await temporaryDirectory("school-hook-")
    const root = join(base, "vault")
    const destination = join(base, "drive")
    const config = join(base, "config.json")
    await mkdir(root)
    await writeFile(config, JSON.stringify({ vault: { path: root, gitInit: false } }))
    expect(await refreshConfiguredReadingMirror(root)).toBeNull()
    await writeFile(join(root, "note.md"), "initial")
    const mirror = await refreshReadingMirror(root, destination)
    const output = join(mirror.path, "note.md.txt")
    const make = (name: string, fails = false) => {
      const program = new Command().option("--config <path>", "configuration", config)
      program.command(name).action(async () => {
        await writeFile(join(root, "note.md"), name)
        if (fails) throw new Error("synthetic failure")
      })
      registerReadingMirrorHook(program)
      return program
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      await make("prep").parseAsync(["prep"], { from: "user" })
      expect(await readFile(output, "utf8")).toBe("prep")
      await make("doctor").parseAsync(["doctor"], { from: "user" })
      expect(await readFile(output, "utf8")).toBe("prep")
      await expect(make("sync", true).parseAsync(["sync"], { from: "user" })).rejects.toThrow(
        "synthetic failure",
      )
      expect(await readFile(output, "utf8")).toBe("prep")
    } finally {
      log.mockRestore()
    }
  })

  it("warns on refresh failure without failing a successful command", async () => {
    const program = new Command().option("--config <path>", "configuration", "/missing/config.json")
    program.command("prep").action(() => {})
    registerReadingMirrorHook(program)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await program.parseAsync(["prep"], { from: "user" })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("local work succeeded"))
    } finally {
      warn.mockRestore()
    }
  })
})
