import { spawnSync } from "node:child_process"
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"
import {
  obsidianLaunchCommand,
  planObsidianVault,
  prepareObsidianVault,
} from "../src/store/obsidian.js"
import { vaultLayout } from "../src/store/paths.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

async function fixture() {
  const directory = await temporaryDirectory("school-obsidian-")
  const root = join(directory, "vault space & café")
  const privatePaths = [
    join(directory, "school.config.json"),
    join(directory, ".env"),
    join(directory, "index.db"),
  ]
  return { root, privatePaths, directory }
}

describe("Obsidian vault integration", () => {
  it("previews a nonexistent vault without creating any files", async () => {
    const input = await fixture()
    const plan = await planObsidianVault(input)
    expect(plan.blockers).toEqual([])
    expect(plan.fileTypes).toEqual({})
    expect(await readdir(input.directory)).toEqual([])
    expect(new URL(plan.uri).searchParams.get("path")).toBe(
      join(input.root, vaultLayout.obsidianGuide),
    )
  })

  it("preserves original formats and settings, with portable course links", async () => {
    const input = await fixture()
    const course = "DEMO-101 (123) [sample]"
    await mkdir(join(input.root, course), { recursive: true })
    await mkdir(join(input.root, ".obsidian"))
    const originals = {
      "reading.pdf": Buffer.from([0, 255, 1]),
      "model.xlsx": Buffer.from([2, 3, 4]),
      "draft.docx": Buffer.from([5, 6, 7]),
      "slides.pptx": Buffer.from([8, 9, 10]),
      "photo.png": Buffer.from([11, 12, 13]),
      "notes.md": Buffer.from("my personal notes"),
    }
    for (const [name, bytes] of Object.entries(originals))
      await writeFile(join(input.root, name), bytes)
    await writeFile(join(input.root, course, vaultLayout.home), "course home")
    await writeFile(join(input.root, ".obsidian", "app.json"), '{"userSetting":true}')
    const result = await prepareObsidianVault(input)
    expect(result.created).toBe(true)
    expect(result.plan.fileTypes[".xlsx"]).toBe(1)
    expect(result.plan.fileTypes[".md"]).toBe(2)
    for (const [name, bytes] of Object.entries(originals))
      expect(await readFile(join(input.root, name))).toEqual(bytes)
    expect(await readFile(join(input.root, ".obsidian", "app.json"), "utf8")).toBe(
      '{"userSetting":true}',
    )
    const guide = await readFile(result.plan.guidePath, "utf8")
    expect(guide).toContain(
      `${encodeURIComponent(course).replace(/\(/g, "%28").replace(/\)/g, "%29")}/${encodeURIComponent(vaultLayout.home)}`,
    )
    expect(guide).toContain("Sync all other types")
    expect(guide).toContain("source: user")
    expect(guide).not.toContain(input.directory)
  })

  it("never overwrites an existing guide or changes its modification time", async () => {
    const input = await fixture()
    const first = await prepareObsidianVault(input)
    await writeFile(first.plan.guidePath, "my edited guide")
    const before = await stat(first.plan.guidePath)
    expect((await prepareObsidianVault(input)).created).toBe(false)
    expect(await readFile(first.plan.guidePath, "utf8")).toBe("my edited guide")
    expect((await stat(first.plan.guidePath)).mtimeMs).toBe(before.mtimeMs)
  })

  it("blocks private filenames recursively without changing the vault", async () => {
    const input = await fixture()
    await mkdir(join(input.root, "nested"), { recursive: true })
    for (const name of [
      ".env",
      ".env.local",
      "school.config.json",
      "index.sqlite-wal",
      "index.db-shm",
    ]) {
      await writeFile(join(input.root, "nested", name), "synthetic private content")
    }
    const plan = await planObsidianVault(input)
    expect(plan.blockers).toHaveLength(5)
    await expect(prepareObsidianVault(input)).rejects.toThrow("blocked")
    expect(await readdir(input.root)).toEqual(["nested"])
  })

  it("blocks configured index paths inside the vault even before they exist", async () => {
    const input = await fixture()
    const unsafe = { ...input, privatePaths: [join(input.root, "state", "custom-index")] }
    expect((await planObsidianVault(unsafe)).blockers).toHaveLength(1)
    await expect(prepareObsidianVault(unsafe)).rejects.toThrow("blocked")
    expect(await readdir(input.directory)).toEqual([])
  })

  it("resolves private-path aliases and does not mistake a sibling prefix for the vault", async () => {
    const input = await fixture()
    await mkdir(input.root)
    await symlink(input.root, join(input.directory, "alias"))
    const alias = { ...input, privatePaths: [join(input.directory, "alias", "future-index")] }
    expect((await planObsidianVault(alias)).blockers).toHaveLength(1)
    const sibling = { ...input, privatePaths: [join(`${input.root}-other`, "index.db")] }
    expect((await planObsidianVault(sibling)).blockers).toEqual([])
  })

  it("does not follow symlinks or write a guide through an existing symlink", async () => {
    const input = await fixture()
    await mkdir(input.root)
    const target = join(input.directory, "original.md")
    await writeFile(target, "preserve me")
    await symlink(target, join(input.root, vaultLayout.obsidianGuide))
    await expect(prepareObsidianVault(input)).rejects.toThrow("blocked")
    expect(await readFile(target, "utf8")).toBe("preserve me")
  })

  it("warns about operational state and undownloaded placeholders", async () => {
    const input = await fixture()
    await mkdir(join(input.root, vaultLayout.metadata), { recursive: true })
    await writeFile(join(input.root, ".reading.pdf.icloud"), "placeholder")
    const plan = await planObsidianVault(input)
    expect(plan.warnings.some((warning) => warning.includes("Exclude _meta"))).toBe(true)
    expect(plan.warnings.some((warning) => warning.includes("placeholder"))).toBe(true)
  })

  it("blocks an invalid guide path but preserves hidden agent state with a provider-specific warning", async () => {
    const input = await fixture()
    await mkdir(join(input.root, vaultLayout.obsidianGuide), { recursive: true })
    await mkdir(join(input.root, ".agent-runs"))
    const plan = await planObsidianVault(input)
    expect(plan.blockers).toHaveLength(1)
    expect(plan.warnings).toHaveLength(1)
    expect(plan.warnings[0]).toContain("Obsidian Sync excludes hidden folders")
    await expect(prepareObsidianVault(input)).rejects.toThrow("blocked")
  })

  it("prepares a used vault without moving or reading hidden draft-run records", async () => {
    const input = await fixture()
    await mkdir(join(input.root, ".agent-runs"), { recursive: true })
    const record = join(input.root, ".agent-runs", "synthetic.json")
    await writeFile(record, "synthetic run record")
    expect((await prepareObsidianVault(input)).created).toBe(true)
    expect(await readFile(record, "utf8")).toBe("synthetic run record")
  })

  it("passes a URI as one argument without shell evaluation", () => {
    const uri = `obsidian://open?path=${encodeURIComponent("/tmp/vault & café/guide.md")}`
    expect(obsidianLaunchCommand(uri, "darwin")).toEqual({ command: "open", args: [uri] })
    expect(obsidianLaunchCommand(uri, "linux")).toEqual({ command: "xdg-open", args: [uri] })
    expect(() => obsidianLaunchCommand(uri, "win32")).toThrow("macOS and Linux")
    expect(() => obsidianLaunchCommand("https://example.test", "darwin")).toThrow("Expected")
  })
})

describe("vault obsidian CLI", () => {
  const repository = fileURLToPath(new URL("..", import.meta.url))
  function run(config: string, ...args: string[]) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "--config", config, "vault", "obsidian", ...args],
      { cwd: repository, encoding: "utf8", timeout: 10_000 },
    )
  }

  it("previews, applies, and preserves through the real CLI without credentials", async () => {
    const input = await fixture()
    const config = input.privatePaths[0] ?? ""
    await writeFile(
      config,
      JSON.stringify({
        vault: { path: input.root, gitInit: false },
        index: { path: input.privatePaths[2] },
      }),
    )
    const preview = run(config)
    expect(preview.status).toBe(0)
    expect(preview.stdout).toContain("Preview only")
    expect(await readdir(input.directory)).toEqual(["school.config.json"])
    expect(run(config, "--apply").status).toBe(0)
    expect(run(config, "--apply").stdout).toContain("Preserved existing")
    expect(await readdir(input.root)).toEqual([vaultLayout.obsidianGuide])
  }, 20_000)

  it("fails before launching when the guide is not prepared", async () => {
    const input = await fixture()
    const config = join(input.directory, "school.config.json")
    await writeFile(
      config,
      JSON.stringify({
        vault: { path: input.root },
        index: { path: join(input.directory, "index.db") },
      }),
    )
    const result = run(config, "--open")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("--apply")
    expect(await readdir(input.directory)).toEqual(["school.config.json"])
  })

  it("returns failure and creates nothing when configuration is inside the vault", async () => {
    const input = await fixture()
    await mkdir(input.root)
    const config = join(input.root, "school.config.json")
    await writeFile(config, JSON.stringify({ vault: { path: input.root } }))
    const result = run(config, "--apply")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("BLOCKED")
    expect(await readdir(input.root)).toEqual(["school.config.json"])
  })
})
