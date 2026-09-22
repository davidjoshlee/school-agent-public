import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const catalogPath = join(repositoryRoot, "test/fixtures/ai-gateway-catalog.json")
const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "school-agent-config-"))
  temporaryDirectories.push(directory)
  return directory
}

async function writeConfig(directory: string, config: object): Promise<string> {
  const configPath = join(directory, "school.config.json")
  await writeFile(configPath, JSON.stringify(config), "utf8")
  return configPath
}

function runSchool(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  )
})

describe("school configuration CLI", () => {
  it("validates config and expands a tilde vault path", async () => {
    // Given: a config that uses a tilde-prefixed vault path.
    const directory = await createTemporaryDirectory()
    const configPath = await writeConfig(directory, { vault: { path: "~/.school-agent-vault" } })

    // When: the user validates and displays it through the CLI.
    const validation = runSchool(["--config", configPath, "config", "validate"])
    const display = runSchool(["--config", configPath, "config", "show"])

    // Then: validation succeeds and the display contains the absolute home path.
    expect(validation.status).toBe(0)
    expect(validation.stdout).toContain("Config valid")
    expect(display.status).toBe(0)
    expect(display.stdout).toContain(join(homedir(), ".school-agent-vault"))
  })

  it("refuses Mobile Documents and iCloud-synced Documents vault paths", async () => {
    // Given: a fake home whose Documents directory is an iCloud-synced symlink.
    const directory = await createTemporaryDirectory()
    const home = join(directory, "home")
    const mobileDocuments = join(home, "Library/Mobile Documents/com~apple~CloudDocs/Documents")
    await mkdir(mobileDocuments, { recursive: true })
    await symlink(mobileDocuments, join(home, "Documents"))
    await mkdir(join(directory, "synced"), { recursive: true })
    const directICloudConfig = await writeConfig(join(directory), {
      vault: { path: "~/Library/Mobile Documents/school-agent" },
    })
    const syncedDocumentsConfig = await writeConfig(join(directory, "synced"), {
      vault: { path: "~/Documents/school-agent" },
    })

    // When: either iCloud-backed location is validated.
    const direct = runSchool(["--config", directICloudConfig, "config", "validate"], {
      ...process.env,
      HOME: home,
    })
    const synced = runSchool(["--config", syncedDocumentsConfig, "config", "validate"], {
      ...process.env,
      HOME: home,
    })

    // Then: both commands loudly refuse the unsafe vault path.
    expect(direct.status).toBe(1)
    expect(direct.stderr).toContain("REFUSING iCloud-synced vault path")
    expect(synced.status).toBe(1)
    expect(synced.stderr).toContain("REFUSING iCloud-synced vault path")
  })

  it("reports the mapping key when a configured model is absent from the catalog", async () => {
    // Given: a user override with an unavailable task model.
    const directory = await createTemporaryDirectory()
    const configPath = await writeConfig(directory, {
      models: {
        triage: "local-triage",
        generation: "local-generation",
        functions: { extractSummary: "unavailable-model" },
      },
    })

    // When: the model registry is checked against the recorded catalog.
    const result = runSchool(["--config", configPath, "models", "check", "--catalog", catalogPath])

    // Then: it fails and identifies the invalid function mapping.
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("models.functions.extractSummary")
  })

  it("rejects a models override without models.triage", async () => {
    // Given: a partial models object that omits the required triage model.
    const directory = await createTemporaryDirectory()
    const configPath = await writeConfig(directory, {
      models: { generation: "configured-generation" },
    })

    // When: the config is validated.
    const result = runSchool(["--config", configPath, "config", "validate"])

    // Then: the missing required config key is named.
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("triage")
  })

  it("keeps model identifier literals out of source files", async () => {
    // Given: all TypeScript implementation files.
    const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url))
    const sourceEntries = await readdir(sourceDirectory, { recursive: true })
    const sourceFiles = sourceEntries.filter((entry) => entry.endsWith(".ts"))
    const source = await Promise.all(
      sourceFiles.map(async (entry) => readFile(join(sourceDirectory, entry), "utf8")),
    )

    // When: model identifier-shaped literals are searched.
    const modelIdPattern = /(claude|gpt|gemini|llama)[-\w.]*/i

    // Then: source code contains no model identifiers.
    expect(source.join("\n")).not.toMatch(modelIdPattern)
  })
})
