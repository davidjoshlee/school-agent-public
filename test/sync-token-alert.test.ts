import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Command } from "commander"
import { HttpResponse, http } from "msw"
import { describe, expect, it, vi } from "vitest"

import { CanvasSyncAuthenticationError } from "../src/canvas/sync.js"
import { registerSyncCommand } from "../src/canvas/sync-cli.js"
import { installCourseHandlers, server } from "./helpers/canvasMock.js"
import { schoolConfig } from "./helpers/schoolConfig.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

async function runSyncCommand(configPath: string, arguments_: readonly string[] = []) {
  const program = new Command()
    .name("school")
    .description("School agent CLI")
    .option("--config <path>", "path to school.config.json", configPath)
    .exitOverride()
  registerSyncCommand(program)
  vi.stubEnv("CANVAS_TOKEN", "fixture-token")
  try {
    return await program.parseAsync(["node", "school", "sync", ...arguments_])
  } finally {
    vi.unstubAllEnvs()
  }
}

describe("sync token-renewal alerts", () => {
  it("raises a durable ALERT.md and rethrows when Canvas rejects the token mid-sync", async () => {
    // Given: Canvas discovery itself returns an expired-token 401 with WWW-Authenticate.
    server.use(
      http.get(
        "https://canvas.test/api/v1/courses",
        () => new HttpResponse(null, { status: 401, headers: { "www-authenticate": "Bearer" } }),
      ),
    )
    const vaultPath = await temporaryDirectory("school-agent-sync-alert-vault-")
    const configPath = join(tmpdir(), `school.config-sync-alert-${Date.now()}.json`)
    await writeFile(configPath, JSON.stringify(schoolConfig({ vaultPath })))

    // When: sync runs and Canvas rejects the token.
    // Then: the CLI still surfaces the authentication error (non-zero exit at the runCli boundary)...
    await expect(runSyncCommand(configPath)).rejects.toBeInstanceOf(CanvasSyncAuthenticationError)

    // ...but not before writing an actionable, durable alert naming the problem and the fix.
    const alert = await readFile(join(vaultPath, "_meta", "ALERT.md"), "utf8")
    expect(alert).toContain("Canvas returned 401")
    expect(alert).toContain("school auth renew")
  })

  it("lets a subsequent successful sync clear a stale token alert", async () => {
    // Given: a vault carrying a stale token-expiry alert from an earlier failed run.
    installCourseHandlers()
    const vaultPath = await temporaryDirectory("school-agent-sync-alert-clear-vault-")
    const metadataDirectory = join(vaultPath, "_meta")
    await mkdir(metadataDirectory, { recursive: true })
    await writeFile(
      join(metadataDirectory, "ALERT.md"),
      "# Canvas returned 401\n\nstale alert from a previous run",
      "utf8",
    )
    const configPath = join(tmpdir(), `school.config-sync-alert-clear-${Date.now()}.json`)
    await writeFile(
      configPath,
      JSON.stringify(schoolConfig({ vaultPath, files: { maxSizeMB: 1 } })),
    )

    // When: a fully successful sync runs.
    await runSyncCommand(configPath)

    // Then: the due-soon reminder write refreshes ALERT.md, so the stale token alert is gone.
    const alert = await readFile(join(metadataDirectory, "ALERT.md"), "utf8")
    expect(alert).not.toContain("Canvas returned 401")
  })
})
