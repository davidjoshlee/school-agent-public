import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdir, readdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { refreshReadingMirror } from "../src/store/reading-mirror.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

async function fixture() {
  const base = await temporaryDirectory("school-mirror-")
  const root = join(base, "vault")
  const destination = join(base, "drive")
  await mkdir(root)
  await writeFile(join(root, "note.md"), "first")
  return { base, root, destination }
}

describe("persistent reading mirror", () => {
  it("rejects configured private files before creating state or output", async () => {
    const { root, destination } = await fixture()
    const index = join(root, "index.txt")
    await writeFile(index, "synthetic private index")
    await expect(refreshReadingMirror(root, destination, undefined, [index])).rejects.toThrow(
      "inside the vault",
    )
    expect(await readdir(root)).not.toContain("_meta")
  })

  it("refuses source ancestor symlinks introduced after planning", async () => {
    const { base, root, destination } = await fixture()
    const course = join(root, "course")
    const privateRoot = join(base, "private")
    await mkdir(course)
    await mkdir(privateRoot)
    await writeFile(join(course, "reading.txt"), "safe reading")
    await writeFile(join(privateRoot, "reading.txt"), "synthetic outside-vault secret")
    await expect(
      refreshReadingMirror(root, destination, (stage) => {
        if (stage.includes("loading local")) {
          renameSync(course, join(root, "previous-course"))
          symlinkSync(privateRoot, course)
        }
      }),
    ).rejects.toThrow("escaped the vault")
    expect(await readdir(base)).not.toContain("drive")
  })

  it("preserves an unowned file created after destination preflight", async () => {
    const { root, destination } = await fixture()
    const target = join(destination, "Current", "note.md.txt")
    await expect(
      refreshReadingMirror(root, destination, (stage) => {
        if (stage.includes("applying changed")) {
          mkdirSync(join(destination, "Current"), { recursive: true })
          writeFileSync(target, "unowned concurrent edit", { flag: "wx" })
        }
      }),
    ).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(target, "utf8")).toBe("unowned concurrent edit")
    expect(await readdir(join(root, "_meta"))).not.toContain("reading-mirror.json")
  })

  it("refuses source parent swaps into excluded in-vault metadata", async () => {
    const { base, root, destination } = await fixture()
    const course = join(root, "course")
    const privateRoot = join(root, "_meta")
    await mkdir(course)
    await mkdir(privateRoot)
    await writeFile(join(course, "reading.txt"), "safe reading")
    await writeFile(join(privateRoot, "reading.txt"), "synthetic private metadata")
    await expect(
      refreshReadingMirror(root, destination, (stage) => {
        if (stage.includes("loading local")) {
          renameSync(course, join(root, "previous-course"))
          symlinkSync(privateRoot, course)
        }
      }),
    ).rejects.toThrow("escaped the vault")
    expect(await readdir(base)).not.toContain("drive")
  })

  it("updates changed files and preserves unchanged mtimes without changing the vault", async () => {
    const { root, destination } = await fixture()
    const first = await refreshReadingMirror(root, destination)
    expect(first.updated).toBe(2)
    const path = join(first.path, "note.md.txt")
    const before = (await stat(path)).mtimeMs
    expect((await refreshReadingMirror(root, destination)).updated).toBe(0)
    expect((await stat(path)).mtimeMs).toBe(before)
    await writeFile(join(root, "note.md"), "second")
    expect((await refreshReadingMirror(root, destination)).updated).toBe(1)
    expect(await readFile(path, "utf8")).toBe("second")
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("second")
  })

  it("recovers Drive edits and files removed from the source instead of deleting them", async () => {
    const { base, root, destination } = await fixture()
    const first = await refreshReadingMirror(root, destination)
    await writeFile(join(first.path, "note.md.txt"), "remote edit")
    const second = await refreshReadingMirror(root, destination)
    expect(second.recovered).toBe(1)
    const recovery = (await readdir(join(destination, "Recovered")))[0] ?? ""
    expect(await readFile(join(destination, "Recovered", recovery, "note.md.txt"), "utf8")).toBe(
      "remote edit",
    )
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("first")
    await rename(join(root, "note.md"), join(base, "removed.md"))
    expect((await refreshReadingMirror(root, destination)).recovered).toBe(1)
    expect(await readdir(first.path)).toEqual(["00 READ ME.txt"])
  })

  it("does not adopt unowned files or follow destination symlinks", async () => {
    const { base, root, destination } = await fixture()
    await mkdir(join(destination, "Current"), { recursive: true })
    await writeFile(join(destination, "Current", "note.md.txt"), "keep")
    await expect(refreshReadingMirror(root, destination)).rejects.toThrow("Unowned")
    expect(await readFile(join(destination, "Current", "note.md.txt"), "utf8")).toBe("keep")
    const target = join(base, "elsewhere")
    await mkdir(target)
    await rename(join(destination, "Current"), join(destination, "previous"))
    await symlink(target, join(destination, "Current"))
    await expect(refreshReadingMirror(root, destination)).rejects.toThrow("Symlink")
    expect(await readdir(target)).toEqual([])
  })

  it("refuses destination changes and competing writers", async () => {
    const { base, root, destination } = await fixture()
    await refreshReadingMirror(root, destination)
    await expect(refreshReadingMirror(root, join(base, "different-drive"))).rejects.toThrow(
      "saved mapping",
    )
    const results = await Promise.allSettled([
      refreshReadingMirror(root, destination),
      refreshReadingMirror(root, destination),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  })
})
