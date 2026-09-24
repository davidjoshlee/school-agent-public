import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const temporaryDirectory = mkdtempSync(join(tmpdir(), "school-agent-package-"))

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: temporaryDirectory,
    encoding: "utf8",
    env: process.env,
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    )
  }
  return result.stdout
}

function installTarball(tarball) {
  // CI must verify a real clean install. Set this only when explicitly testing
  // whether the npm cache alone is sufficient for the smoke test.
  const offline = process.env.SCHOOL_AGENT_PACKAGE_SMOKE_OFFLINE === "true"
  const arguments_ = ["install", "--no-audit", "--no-fund"]
  if (offline) arguments_.push("--offline")
  arguments_.push(tarball)
  const install = spawnSync("npm", arguments_, {
    cwd: temporaryDirectory,
    encoding: "utf8",
    env: process.env,
  })
  if (install.status === 0) return
  const mode = offline ? "offline" : "online"
  throw new Error(`${mode} tarball install failed:\n${install.stdout}\n${install.stderr}`)
}

try {
  const packed = run("npm", ["pack", "--json", "--pack-destination", temporaryDirectory], {
    cwd: root,
  })
  const packResult = JSON.parse(packed)
  const tarball = join(temporaryDirectory, packResult[0].filename)
  if (!existsSync(tarball)) {
    throw new Error("npm pack did not create a tarball")
  }

  const packageEntries = run("tar", ["-tzf", tarball]).trim().split("\n")
  const allowedEntry =
    /^package\/(?:bin\/school\.js|config\/(?:model-prices\.default|models\.default)\.json|dist\/.+\.js|src\/(?:.+\.ts|.+\/README\.md)|README\.md|LICENSE|package\.json)$/u
  const unexpectedEntries = packageEntries.filter((entry) => !allowedEntry.test(entry))
  if (unexpectedEntries.length > 0) {
    throw new Error(`tarball contains unexpected files: ${unexpectedEntries.join(", ")}`)
  }
  const credentialEntries = packageEntries.filter((entry) =>
    /(?:^|\/)(?:\.env(?:\..*)?|school\.config\.json)$/u.test(entry),
  )
  if (credentialEntries.length > 0) {
    throw new Error(
      `tarball contains credentials or user configuration: ${credentialEntries.join(", ")}`,
    )
  }

  installTarball(tarball)
  const executable = join(temporaryDirectory, "node_modules", ".bin", "school")
  const alternateExecutable = join(temporaryDirectory, "node_modules", ".bin", "school-agent")
  const configDirectory = join(temporaryDirectory, "configuration")
  mkdirSync(configDirectory)
  const configPath = join(configDirectory, "school.config.json")

  run(executable, ["--help"])
  run(alternateExecutable, ["--help"])
  run(executable, ["--config", configPath, "setup", "--canvas-url", "https://canvas.example.test"])
  writeFileSync(
    join(configDirectory, ".env"),
    "CANVAS_TOKEN=dotenv-token\nAI_GATEWAY_API_KEY=dotenv-key\n",
    "utf8",
  )
  run(executable, ["--config", configPath, "doctor"])

  const config = JSON.parse(readFileSync(configPath, "utf8"))
  if (config.canvas?.baseUrl !== "https://canvas.example.test") {
    throw new Error("setup did not write the requested Canvas URL")
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
