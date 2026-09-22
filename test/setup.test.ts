import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createStarterConfig, doctor, SetupError } from "../src/config/setup.js"

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "school-agent-setup-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  )
})

describe("friend setup", () => {
  it("writes an intentionally small, local-only starter configuration without credentials", async () => {
    const directory = await temporaryDirectory()
    const home = join(directory, "home")
    const configurationPath = join(directory, "school.config.json")

    const result = createStarterConfig(
      configurationPath,
      { canvasUrl: "https://school.instructure.com" },
      home,
    )

    const configuration = JSON.parse(await readFile(result.configPath, "utf8")) as Record<
      string,
      unknown
    >
    expect(configuration).toMatchObject({
      canvas: { baseUrl: "https://school.instructure.com", tokenEnv: "CANVAS_TOKEN" },
      vault: { path: join(home, "school-vault"), gitInit: false },
      index: { path: join(home, ".local/share/school-agent/index.db") },
      courses: { mode: "list", allowlist: [], pilotCourseId: null },
      cost: { maxMonthlySpendUSD: 15 },
    })
    const environment = await readFile(result.environmentPath, "utf8")
    expect(environment).toContain("CANVAS_TOKEN=\n")
    expect(environment).not.toContain("<your")
  })

  it("refuses setup before changing either file when a setup file already exists", async () => {
    const directory = await temporaryDirectory()
    const configurationPath = join(directory, "school.config.json")
    await writeFile(configurationPath, "keep this configuration", "utf8")

    expect(() =>
      createStarterConfig(configurationPath, { canvasUrl: "https://school.instructure.com" }),
    ).toThrow(SetupError)
    expect(await readFile(configurationPath, "utf8")).toBe("keep this configuration")
    await expect(readFile(join(directory, ".env"), "utf8")).rejects.toThrow()
  })

  it("doctor reports credential presence without ever including credential values", async () => {
    const directory = await temporaryDirectory()
    const configurationPath = join(directory, "school.config.json")
    createStarterConfig(
      configurationPath,
      { canvasUrl: "https://school.instructure.com" },
      directory,
    )

    const report = doctor(
      configurationPath,
      { syncOnly: true },
      { CANVAS_TOKEN: "canvas-secret-value", AI_GATEWAY_API_KEY: "gateway-secret-value" },
    )

    const output = report.findings.map((finding) => finding.message).join("\n")
    expect(report.healthy).toBe(true)
    expect(output).toContain("Canvas credential is present")
    expect(output).not.toContain("canvas-secret-value")
    expect(output).not.toContain("gateway-secret-value")
  })

  it("treats an absent Canvas credential as an error and an absent AI key as a sync-only warning", async () => {
    const directory = await temporaryDirectory()
    const configurationPath = join(directory, "school.config.json")
    createStarterConfig(
      configurationPath,
      { canvasUrl: "https://school.instructure.com" },
      directory,
    )

    const report = doctor(configurationPath, { syncOnly: true }, {})

    expect(report.healthy).toBe(false)
    expect(report.findings).toContainEqual(
      expect.objectContaining({ level: "error", message: expect.stringContaining("CANVAS_TOKEN") }),
    )
    expect(report.findings).toContainEqual(
      expect.objectContaining({ level: "warning", message: expect.stringContaining("sync-only") }),
    )
  })
})
