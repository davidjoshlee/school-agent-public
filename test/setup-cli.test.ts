import { spawnSync } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "school-agent-first-run-"))
  temporaryDirectories.push(directory)
  return directory
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
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe("first-run setup CLI", () => {
  it("explains invalid Canvas URLs and leaves setup files untouched", async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, "school.config.json")

    const result = runSchool([
      "--config",
      configPath,
      "setup",
      "--canvas-url",
      "http://canvas.example.edu",
    ])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("HTTPS Canvas URL")
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it("tells new users where to add the Canvas token without exposing a value", async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, "school.config.json")
    const result = runSchool([
      "--config",
      configPath,
      "setup",
      "--canvas-url",
      "https://canvas.example.edu",
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(".env")
    expect(result.stdout).toContain("CANVAS_TOKEN")
    expect(await readFile(join(directory, ".env"), "utf8")).toContain("CANVAS_TOKEN=\n")
    expect(result.stdout).not.toContain("canvas-secret")
  })

  it("walks a synthetic first-run setup through doctor and keeps the course allowlist empty", async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, "school.config.json")
    const setup = runSchool([
      "--config",
      configPath,
      "setup",
      "--canvas-url",
      "https://canvas.example.edu",
    ])
    expect(setup.status).toBe(0)

    await writeFile(join(directory, ".env"), "CANVAS_TOKEN=synthetic-token\n", "utf8")
    const doctor = runSchool(["--config", configPath, "doctor", "--sync-only"], {
      ...process.env,
      CANVAS_TOKEN: "synthetic-token",
    })

    expect(doctor.status).toBe(0)
    expect(doctor.stdout).toContain("Canvas credential is present")
    expect(doctor.stdout).toContain("AI credential is absent (fine for sync-only use)")
    expect(doctor.stdout).not.toContain("synthetic-token")
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      courses: { allowlist: string[] }
    }
    expect(config.courses.allowlist).toEqual([])
  })

  it("keeps doctor offline by default and makes --ai fail early when its key is blank", async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, "school.config.json")
    runSchool(["--config", configPath, "setup", "--canvas-url", "https://canvas.example.edu"])
    const environment = {
      ...process.env,
      CANVAS_TOKEN: "synthetic-token",
      AI_GATEWAY_API_KEY: "  ",
    }

    const offline = runSchool(["--config", configPath, "doctor", "--sync-only"], environment)
    expect(offline.status).toBe(0)
    expect(offline.stdout).not.toContain("AI readiness sends")

    const ai = runSchool(["--config", configPath, "doctor", "--sync-only", "--ai"], environment)
    expect(ai.status).toBe(1)
    expect(ai.stdout).toContain("may incur provider charges")
    expect(ai.stdout).toContain("AI Gateway key is missing or blank")
    expect(ai.stdout).not.toContain("synthetic-token")
  })
})
