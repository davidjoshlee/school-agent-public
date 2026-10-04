import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { ConfigError, persistCourseSelection, persistPilotCourse } from "../src/config/index.js"

const directories: string[] = []

async function configurationPath(content: object | string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "school-config-persistence-"))
  directories.push(directory)
  const path = join(directory, "school.config.json")
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content), "utf8")
  return path
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("course configuration persistence", () => {
  it("updates selection and pilot independently while preserving unrelated settings", async () => {
    const path = await configurationPath({
      canvas: { baseUrl: "https://canvas.example.edu", tokenEnv: "EXAMPLE_TOKEN" },
      courses: { mode: "auto", allowlist: ["old"], pilotCourseId: "pilot" },
      cost: { maxMonthlySpendUSD: 7 },
    })

    persistCourseSelection(path, ["course-b", "course-a", "course-b"])
    const selection = JSON.parse(await readFile(path, "utf8"))
    expect(selection.courses).toEqual({
      mode: "list",
      allowlist: ["course-b", "course-a"],
      pilotCourseId: "pilot",
    })

    persistPilotCourse(path, "course-a")
    const content = await readFile(path, "utf8")
    expect(JSON.parse(content)).toEqual({
      ...selection,
      courses: { ...selection.courses, pilotCourseId: "course-a" },
    })
    expect(selection.canvas).toEqual({
      baseUrl: "https://canvas.example.edu",
      tokenEnv: "EXAMPLE_TOKEN",
    })
    expect(selection.cost).toEqual({ maxMonthlySpendUSD: 7 })
    expect(content).toBe(`${JSON.stringify(JSON.parse(content), null, 2)}\n`)
  })

  it.each([persistCourseSelection, persistPilotCourse])(
    "does not overwrite malformed configuration",
    async (persist) => {
      const content = "{ invalid json"
      const path = await configurationPath(content)
      expect(() => {
        if (persist === persistCourseSelection) persistCourseSelection(path, ["course"])
        else persistPilotCourse(path, "course")
      }).toThrow(ConfigError)
      expect(await readFile(path, "utf8")).toBe(content)
    },
  )
})
