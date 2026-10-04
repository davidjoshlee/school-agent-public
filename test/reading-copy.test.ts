import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Command } from "commander"
import { describe, expect, it } from "vitest"

import { createReadingCopy, planReadingCopy, readingText } from "../src/store/reading-copy.js"
import { registerReadingCopyCommand } from "../src/store/reading-copy-cli.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

describe("phone reading snapshots", () => {
  it.each(["index.txt", "configuration.txt"])(
    "rejects private paths regardless of extension: %s",
    async (name) => {
      const base = await temporaryDirectory("school-reading-private-")
      const root = join(base, "vault")
      const destination = join(base, "drive")
      await mkdir(root)
      const privatePath = join(root, name)
      await writeFile(privatePath, "synthetic private state")
      const alias = join(base, "private-alias")
      await symlink(privatePath, alias)
      await expect(planReadingCopy(root, destination, [alias])).rejects.toThrow("inside the vault")
      await expect(createReadingCopy(root, destination, [privatePath])).rejects.toThrow(
        "inside the vault",
      )
      expect(await readdir(base)).not.toContain("drive")
    },
  )

  it.each([{ flags: [] }, { flags: ["--apply"] }, { flags: ["--current", "--apply"] }])(
    "CLI rejects a private index before exporting with $flags",
    async ({ flags }) => {
      const base = await temporaryDirectory("school-reading-cli-private-")
      const root = join(base, "vault")
      const destination = join(base, "drive")
      const configPath = join(base, "config.txt")
      await mkdir(root)
      const index = join(root, "index.txt")
      await writeFile(index, "synthetic private index")
      await writeFile(configPath, JSON.stringify({ vault: { path: root }, index: { path: index } }))
      const program = new Command().option("--config <path>", "config", configPath)
      registerReadingCopyCommand(program.command("vault"), program)
      await expect(
        program.parseAsync(["vault", "reading-copy", "--destination", destination, ...flags], {
          from: "user",
        }),
      ).rejects.toThrow("inside the vault")
      expect(await readdir(base)).not.toContain("drive")
    },
  )

  it("previews without writing and exports notes plus binary originals, not operational state", async () => {
    const base = await temporaryDirectory("school-reading-")
    const root = join(base, "vault")
    const destination = join(base, "drive")
    await mkdir(join(root, "DEMO-101", "Prep"), { recursive: true })
    const note = join(root, "DEMO-101", "Prep", "brief.md")
    await writeFile(note, "---\ncanvas_url: https://canvas.test\n---\n# Prep\nMy reading brief.")
    const original = Buffer.from([0, 255, 42])
    await writeFile(join(root, "DEMO-101", "model.xlsx"), original)
    for (const folder of [".agent-runs", "_meta", "old", "_simulations", "DEMO-101/_meta"]) {
      await mkdir(join(root, folder), { recursive: true })
      await writeFile(join(root, folder, "private.md"), "do not export")
    }
    await writeFile(join(root, ".env"), "synthetic secret")
    await writeFile(join(root, "school.config.json"), "private config")
    await writeFile(join(root, "index.db"), "private database")
    await writeFile(join(root, "DEMO-101", "_index.md"), "private manifest")
    const plan = await planReadingCopy(root, destination)
    expect(plan.files).toHaveLength(2)
    expect(await readdir(base)).toEqual(["vault"])
    const result = await createReadingCopy(root, destination)
    expect(await readFile(join(result.path, "DEMO-101", "Prep", "brief.md.txt"), "utf8")).toBe(
      "# Prep\nMy reading brief.",
    )
    expect(await readFile(join(result.path, "DEMO-101", "model.xlsx"))).toEqual(original)
    expect((await readdir(result.path)).sort()).toEqual(["00 READ ME.txt", "DEMO-101"])
    expect(await readFile(note, "utf8")).toContain("canvas_url")
  })

  it("never overwrites an existing snapshot or sends remote edits back", async () => {
    const base = await temporaryDirectory("school-reading-repeat-")
    const root = join(base, "vault")
    await mkdir(root)
    await writeFile(join(root, "notes.md"), "first")
    const first = await createReadingCopy(root, join(base, "drive"))
    await writeFile(join(first.path, "notes.md.txt"), "phone edit")
    await writeFile(join(root, "notes.md"), "second")
    const second = await createReadingCopy(root, join(base, "drive"))
    expect(first.path).not.toBe(second.path)
    expect(await readFile(join(first.path, "notes.md.txt"), "utf8")).toBe("phone edit")
    expect(await readFile(join(second.path, "notes.md.txt"), "utf8")).toBe("second")
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("second")
  })

  it("rejects overlapping destinations, including symlink aliases", async () => {
    const base = await temporaryDirectory("school-reading-path-")
    const root = join(base, "vault")
    await mkdir(root)
    await symlink(root, join(base, "alias"))
    for (const target of [root, join(root, "copy"), base, join(base, "alias", "copy")]) {
      await expect(planReadingCopy(root, target)).rejects.toThrow("separate")
    }
  })

  it("skips symlinks rather than following them outside the vault", async () => {
    const base = await temporaryDirectory("school-reading-link-")
    const root = join(base, "vault")
    await mkdir(root)
    await writeFile(join(base, "private.txt"), "secret")
    await symlink(join(base, "private.txt"), join(root, "reading.txt"))
    expect((await planReadingCopy(root, join(base, "drive"))).files).toHaveLength(0)
  })

  it("strips frontmatter and known signed-query values without modifying source", () => {
    expect(
      readingText(
        "---\r\nsource: agent\r\n---\r\nRead https://canvas.test/file?verifier=secret&wrap=1",
      ),
    ).toBe("Read https://canvas.test/file?verifier=[redacted]&wrap=1")
    expect(readingText("https://files.test/a?X-Amz-Signature=secret")).not.toContain("secret")
  })

  it("rejects converted-name collisions before writing any destination files", async () => {
    const base = await temporaryDirectory("school-reading-collision-")
    const root = join(base, "vault")
    await mkdir(root)
    await writeFile(join(root, "note.md"), "markdown")
    await writeFile(join(root, "note.md.txt"), "different text")
    await expect(createReadingCopy(root, join(base, "drive"))).rejects.toThrow("collide")
    expect(await readdir(base)).toEqual(["vault"])
  })
})
