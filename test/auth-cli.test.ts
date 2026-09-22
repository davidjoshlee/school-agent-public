import { spawn } from "node:child_process"
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const temporaryDirectories: string[] = []

type SchoolResult = {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "school-agent-auth-"))
  temporaryDirectories.push(directory)
  return directory
}

async function writeConfig(directory: string, vaultPath: string, baseUrl: string): Promise<string> {
  const configPath = join(directory, "school.config.json")
  await writeFile(
    configPath,
    JSON.stringify({ canvas: { baseUrl }, vault: { path: vaultPath } }),
    "utf8",
  )
  return configPath
}

function runSchool(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<SchoolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...arguments_], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (status) => {
      resolve({ status: status ?? 1, stdout, stderr })
    })
  })
}

async function createUnauthorizedServer(): Promise<{
  readonly baseUrl: string
  readonly close: () => Promise<void>
}> {
  const server = createServer((_, response) => {
    response.writeHead(401, { "WWW-Authenticate": 'Bearer realm="Canvas"' })
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server did not expose a TCP address")
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

async function createUnavailableKeychain(directory: string): Promise<string> {
  const binDirectory = join(directory, "bin")
  await mkdir(binDirectory)
  const securityPath = join(binDirectory, "security")
  await writeFile(securityPath, "#!/bin/sh\nexit 44\n", "utf8")
  await chmod(securityPath, 0o700)
  return binDirectory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  )
})

describe("school auth CLI", () => {
  it("exits 1 with re-mint guidance when Canvas rejects a fixture token", async () => {
    // Given: a local HTTP fixture that returns Canvas's re-authentication response.
    const directory = await createTemporaryDirectory()
    const server = await createUnauthorizedServer()
    const configPath = await writeConfig(directory, join(directory, "vault"), server.baseUrl)

    // When: verification uses a fixture token against that endpoint.
    const result = await runSchool(["--config", configPath, "auth", "verify"], {
      ...process.env,
      CANVAS_TOKEN: "fixture-token",
    })
    await server.close()

    // Then: it fails without exposing the token and directs the user to re-mint it.
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Re-mint")
    expect(result.stderr).not.toContain("fixture-token")
  })

  it("points to the runbook when neither environment nor Keychain supplies a token", async () => {
    // Given: an empty token environment and a fixture Keychain executable that has no credential.
    const directory = await createTemporaryDirectory()
    const binDirectory = await createUnavailableKeychain(directory)
    const configPath = await writeConfig(
      directory,
      join(directory, "vault"),
      "https://example.invalid",
    )

    // When: verification resolves its credential.
    const result = await runSchool(["--config", configPath, "auth", "verify"], {
      ...process.env,
      CANVAS_TOKEN: "",
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
    })

    // Then: it does not make a network request and offers the documented recovery path.
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("docs/auth-runbook.md")
  })

  it("raises a durable alert and exits non-zero when the recorded token is expired", async () => {
    // Given: an expiry record that is already past its confirmed expiration date.
    const directory = await createTemporaryDirectory()
    const vaultPath = join(directory, "vault")
    const configPath = await writeConfig(directory, vaultPath, "https://example.invalid")
    const metadataDirectory = join(vaultPath, "_meta")
    await mkdir(metadataDirectory, { recursive: true })
    await writeFile(
      join(metadataDirectory, "auth.json"),
      JSON.stringify({
        minted_at: "2026-07-01T00:00:00.000Z",
        expires_at: "2026-07-31T00:00:00.000Z",
      }),
      "utf8",
    )

    // When: status reads the recorded metadata.
    const result = await runSchool(["--config", configPath, "auth", "status"], process.env)

    // Then: it fails loudly and leaves an actionable, durable alert behind.
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("EXPIRED")
    const alert = await readFile(join(metadataDirectory, "ALERT.md"), "utf8")
    expect(alert).toContain("Canvas token expired")
    expect(alert).toContain("school auth renew")
  })

  it("warns without failing or alerting when the token is only near expiry", async () => {
    // Given: an expiry record inside the default five-day renewal window.
    const directory = await createTemporaryDirectory()
    const vaultPath = join(directory, "vault")
    const configPath = await writeConfig(directory, vaultPath, "https://example.invalid")
    const metadataDirectory = join(vaultPath, "_meta")
    await mkdir(metadataDirectory, { recursive: true })
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
    await writeFile(
      join(metadataDirectory, "auth.json"),
      JSON.stringify({ minted_at: new Date().toISOString(), expires_at: soon }),
      "utf8",
    )

    // When: status reads the recorded metadata.
    const result = await runSchool(["--config", configPath, "auth", "status"], process.env)

    // Then: it is a non-blocking heads-up with no durable alert file written.
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("WARNING")
    await expect(access(join(metadataDirectory, "ALERT.md"))).rejects.toThrow()
  })

  it("prints renewal steps, opens the settings URL, and exits 0 on auth renew", async () => {
    // Given: a fake `open` on PATH that records its invocation instead of launching a browser.
    const directory = await createTemporaryDirectory()
    const binDirectory = join(directory, "bin")
    await mkdir(binDirectory)
    const marker = join(directory, "opened.txt")
    const openPath = join(binDirectory, "open")
    await writeFile(openPath, `#!/bin/sh\necho "$1" > ${JSON.stringify(marker)}\n`, "utf8")
    await chmod(openPath, 0o700)
    const vaultPath = join(directory, "vault")
    const configPath = await writeConfig(directory, vaultPath, "https://canvas.example.invalid")

    // When: renew is invoked.
    const result = await runSchool(["--config", configPath, "auth", "renew"], {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
    })

    // Then: it exits 0, prints the settings URL and login/verify steps, and opened it.
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("https://canvas.example.invalid/profile/settings")
    expect(result.stdout).toContain("school auth login")
    expect(result.stdout).toContain("school auth verify")
    await expect(readFile(marker, "utf8")).resolves.toContain(
      "https://canvas.example.invalid/profile/settings",
    )
  })
})
