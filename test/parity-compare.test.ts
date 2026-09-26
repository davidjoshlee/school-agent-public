import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { compareCourseVaults } from "../scripts/parity-compare.mjs"
import { temporaryDirectory } from "./helpers/tempDir.js"

async function course(root: string, name: string, id: string, content = "same bytes\n") {
  const directory = join(root, name)
  await mkdir(join(directory, "Week 01", "Prep"), { recursive: true })
  await writeFile(join(directory, "_index.md"), `---\ncanvas_id: "${id}"\n---\n# Index\n`)
  await writeFile(join(directory, "Week 01", "Prep", "brief.md"), content)
}

describe("vault parity comparator", () => {
  it("compares course content by Canvas identity across different root names", async () => {
    const left = await temporaryDirectory("parity-left-")
    const right = await temporaryDirectory("parity-right-")
    await course(left, "DEMO-101", "101")
    await course(right, "course-101", "101")
    expect(await compareCourseVaults(left, right)).toEqual([])
  })

  it("reports missing and changed files", async () => {
    const left = await temporaryDirectory("parity-left-")
    const right = await temporaryDirectory("parity-right-")
    await course(left, "DEMO-101", "101")
    await course(right, "course-101", "101", "different\n")
    await writeFile(join(right, "course-101", "extra.md"), "extra\n")
    expect(await compareCourseVaults(left, right)).toEqual([
      { course: "101", path: "extra.md", reason: "candidate only" },
      { course: "101", path: "Week 01/Prep/brief.md", reason: "content differs" },
    ])
  })

  it("refuses ambiguous identities and compares unindexed user folders", async () => {
    const left = await temporaryDirectory("parity-left-")
    const right = await temporaryDirectory("parity-right-")
    await course(left, "DEMO-101", "101")
    await course(left, "copy-of-DEMO-101", "101")
    await course(right, "course-101", "101")
    await expect(compareCourseVaults(left, right)).rejects.toThrow("Duplicate Canvas identity")

    const other = await temporaryDirectory("parity-unindexed-")
    await mkdir(join(other, "unexpected"))
    expect(await compareCourseVaults(other, right)).toContainEqual({
      course: "unindexed:unexpected",
      path: "",
      reason: "candidate course missing",
    })
  })
})
