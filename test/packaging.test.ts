import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { loadEnvironmentForConfig } from "../bin/school.js"

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "school-agent-packaging-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("package launcher", () => {
  it("loads missing values from the .env beside an explicitly selected config", () => {
    const directory = temporaryDirectory()
    const configPath = join(directory, "elsewhere", "school.config.json")
    const environment: NodeJS.ProcessEnv = { EXPORTED: "from-shell" }
    const configDirectory = join(directory, "elsewhere")
    mkdirSync(configDirectory)
    writeFileSync(join(directory, ".env"), "EXPORTED=wrong\nDOTENV_ONLY=loaded\n", "utf8")
    writeFileSync(join(configDirectory, ".env"), "EXPORTED=wrong\nDOTENV_ONLY=loaded\n", "utf8")

    loadEnvironmentForConfig(configPath, environment)

    expect(environment).toMatchObject({ EXPORTED: "from-shell", DOTENV_ONLY: "loaded" })
  })
})
