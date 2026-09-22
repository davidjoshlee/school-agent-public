import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { runCli } from "../src/cli.js"
import { VaultWriter, vaultSources, vaultStatuses } from "../src/store/vault.js"

const course = {
  code: "STRAT 101",
  canvasId: "17",
  canvasUrl: "https://canvas.example.invalid/courses/17",
  aiPolicy: "allowed" as const,
}

async function seedCourse(root: string): Promise<void> {
  const writer = new VaultWriter({ root, gitInit: false })
  await writer.write({
    course,
    kind: "assignments",
    title: "Seed assignment",
    canvasId: "seed-1",
    canvasUrl: course.canvasUrl,
    content: "seed",
    source: vaultSources.sync,
    status: vaultStatuses.final,
  })
  await writer.writeCourseManifest({ course, restrictedFileHandling: "exclude" })
}

describe("school ingest CLI", () => {
  it("writes an off-Canvas file into the matched course's files/ and regenerates the manifest", async () => {
    // Given: a vault with a synced course and a local exhibit file to ingest.
    const root = await mkdtemp(join(tmpdir(), "school-agent-ingest-cli-"))
    const configPath = join(root, "school.config.json")
    const vaultPath = join(root, "vault")
    await seedCourse(vaultPath)
    const exhibitPath = join(root, "exhibit.txt")
    await writeFile(exhibitPath, "ExampleWorks exhibit numbers: revenue 42.", "utf8")
    await writeFile(
      configPath,
      JSON.stringify({
        vault: { path: vaultPath, gitInit: false },
        index: { path: join(root, "index.db") },
      }),
      "utf8",
    )
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      // When: ingesting the exhibit against the course's Canvas id, as of a fixed date.
      const exitCode = await runCli([
        "--config",
        configPath,
        "ingest",
        exhibitPath,
        "--course",
        course.canvasId,
        "--title",
        "ExampleWorks Exhibit",
        "--as-of",
        "2025-10-01",
      ])

      // Then: the artifact is written under files/ with the extracted text and user provenance.
      expect(exitCode).toBe(0)
      expect(log).toHaveBeenCalledTimes(1)
      const writtenPath = log.mock.calls[0]?.[0] as string
      expect(writtenPath).toContain(join(vaultPath, "strat-101", "files"))
      const written = await readFile(writtenPath, "utf8")
      expect(written).toContain("ExampleWorks exhibit numbers: revenue 42.")
      expect(written).toContain("source: user")
      expect(written).toContain("2025-10-01")

      // And: the manifest gains a row for the new file.
      const manifest = await readFile(join(vaultPath, "strat-101", "_index.md"), "utf8")
      expect(manifest).toContain("files/exampleworks-exhibit.md")
    } finally {
      log.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("writes module_canvas_id frontmatter when --module is passed", async () => {
    // Given: a vault with a synced course and a local exhibit file to ingest.
    const root = await mkdtemp(join(tmpdir(), "school-agent-ingest-cli-module-"))
    const configPath = join(root, "school.config.json")
    const vaultPath = join(root, "vault")
    await seedCourse(vaultPath)
    const exhibitPath = join(root, "exhibit.txt")
    await writeFile(exhibitPath, "Manually-added exhibit body.", "utf8")
    await writeFile(
      configPath,
      JSON.stringify({
        vault: { path: vaultPath, gitInit: false },
        index: { path: join(root, "index.db") },
      }),
      "utf8",
    )
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      // When: ingesting the exhibit tagged with a module canvas id.
      const exitCode = await runCli([
        "--config",
        configPath,
        "ingest",
        exhibitPath,
        "--course",
        course.canvasId,
        "--title",
        "Manual Exhibit",
        "--as-of",
        "2025-10-01",
        "--module",
        "408594",
      ])

      // Then: the artifact carries the durable module_canvas_id link.
      expect(exitCode).toBe(0)
      const writtenPath = log.mock.calls[0]?.[0] as string
      const written = await readFile(writtenPath, "utf8")
      expect(written).toContain("module_canvas_id: '408594'")
    } finally {
      log.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("errors clearly and writes nothing when the course id has no match in the vault", async () => {
    // Given: a vault with one synced course and a file to ingest against an unknown course id.
    const root = await mkdtemp(join(tmpdir(), "school-agent-ingest-cli-missing-"))
    const configPath = join(root, "school.config.json")
    const vaultPath = join(root, "vault")
    await seedCourse(vaultPath)
    const exhibitPath = join(root, "exhibit.txt")
    await writeFile(exhibitPath, "exhibit body", "utf8")
    await writeFile(
      configPath,
      JSON.stringify({
        vault: { path: vaultPath, gitInit: false },
        index: { path: join(root, "index.db") },
      }),
      "utf8",
    )
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      // When: ingesting against a Canvas course id that is not in the vault.
      const exitCode = await runCli([
        "--config",
        configPath,
        "ingest",
        exhibitPath,
        "--course",
        "999",
      ])

      // Then: the command fails clearly and writes no artifact.
      expect(exitCode).toBe(1)
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Course not found in the vault"))
    } finally {
      error.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
