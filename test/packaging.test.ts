import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { loadEnvironmentForConfig, resolveConfigPath } from "../src/config/location.js"

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
  it("resolves explicit, legacy, and stable default config paths", () => {
    const directory = temporaryDirectory()
    const home = join(directory, "home")
    const expectedDefault = join(home, ".config", "school-agent", "school.config.json")
    expect(resolveConfigPath([], directory, home)).toBe(expectedDefault)
    expect(resolveConfigPath(["--config", "custom/config.json"], directory, home)).toBe(
      join(directory, "custom/config.json"),
    )
    writeFileSync(join(directory, "school.config.json"), "{}", "utf8")
    expect(resolveConfigPath([], directory, home)).toBe(join(directory, "school.config.json"))
  })

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
