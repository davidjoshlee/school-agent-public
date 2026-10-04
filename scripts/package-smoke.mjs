import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const temporaryDirectory = mkdtempSync(join(tmpdir(), "school-agent-package-"))
const isolatedHome = join(temporaryDirectory, "home")
mkdirSync(isolatedHome)
const smokeEnvironment = {
  ...process.env,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  npm_config_cache: join(isolatedHome, ".npm-cache"),
}
delete smokeEnvironment.CANVAS_TOKEN
delete smokeEnvironment.AI_GATEWAY_API_KEY
delete smokeEnvironment.VERCEL_OIDC_TOKEN
delete smokeEnvironment.NPM_TOKEN

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: temporaryDirectory,
    encoding: "utf8",
    env: smokeEnvironment,
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
    env: smokeEnvironment,
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
  const defaultConfigPath = join(isolatedHome, ".config", "school-agent", "school.config.json")
  const defaultEnvPath = join(isolatedHome, ".config", "school-agent", ".env")
  const configDirectory = join(temporaryDirectory, "configuration")
  const alternateDirectory = join(temporaryDirectory, "alternate-cwd")
  const legacyDirectory = join(temporaryDirectory, "legacy-cwd")
  mkdirSync(configDirectory)
  mkdirSync(alternateDirectory)
  mkdirSync(legacyDirectory)
  const explicitConfigPath = join(configDirectory, "school.config.json")

  const expectedVersion = `${packResult[0].version}\n`
  for (const command of [executable, alternateExecutable]) {
    const actualVersion = run(command, ["--version"])
    if (actualVersion !== expectedVersion) {
      throw new Error(
        `installed CLI reported ${actualVersion.trim()}, expected ${expectedVersion.trim()}`,
      )
    }
  }
  run(executable, ["--help"])
  run(alternateExecutable, ["--help"])
  // HOME is isolated for every packaged command, keeping setup output private
  // to this disposable smoke-test directory.
  run(executable, ["setup", "--canvas-url", "https://canvas.example.test"])
  if (!existsSync(defaultConfigPath) || !existsSync(defaultEnvPath)) {
    throw new Error("default setup did not create config and adjacent .env under isolated HOME")
  }
  writeFileSync(defaultEnvPath, "CANVAS_TOKEN=synthetic-token\n", "utf8")

  const defaultDoctor = run(executable, ["doctor"], { cwd: alternateDirectory })
  if (!defaultDoctor.includes(defaultConfigPath)) {
    throw new Error("doctor from another cwd did not use the default user-level config")
  }

  const legacyConfigPath = join(legacyDirectory, "school.config.json")
  const legacyConfig = JSON.parse(readFileSync(defaultConfigPath, "utf8"))
  legacyConfig.canvas.baseUrl = "https://legacy.example.test"
  writeFileSync(legacyConfigPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, "utf8")
  writeFileSync(join(legacyDirectory, ".env"), "CANVAS_TOKEN=synthetic-token\n", "utf8")
  const legacyDoctor = run(executable, ["doctor"], { cwd: legacyDirectory })
  if (!legacyDoctor.includes(legacyConfigPath)) {
    throw new Error("doctor did not prefer an existing cwd school.config.json")
  }

  run(executable, [
    "--config",
    explicitConfigPath,
    "setup",
    "--canvas-url",
    "https://explicit.example.test",
  ])
  writeFileSync(join(configDirectory, ".env"), "CANVAS_TOKEN=synthetic-token\n", "utf8")
  const explicitDoctor = run(executable, ["--config", explicitConfigPath, "doctor"], {
    cwd: legacyDirectory,
  })
  if (!explicitDoctor.includes(explicitConfigPath)) {
    throw new Error("doctor did not prefer an explicitly selected config")
  }

  const config = JSON.parse(readFileSync(defaultConfigPath, "utf8"))
  if (config.canvas?.baseUrl !== "https://canvas.example.test") {
    throw new Error("setup did not write the requested Canvas URL")
  }

  // Exercise reading access with the installed package, without cloud or user files.
  const vaultPath = join(temporaryDirectory, "vault with spaces")
  config.vault.path = vaultPath
  config.index.path = join(temporaryDirectory, "index.db")
  writeFileSync(defaultConfigPath, JSON.stringify(config), "utf8")
  run(executable, ["vault", "obsidian"])
  if (existsSync(vaultPath)) throw new Error("Obsidian preview unexpectedly created a vault")
  run(executable, ["vault", "obsidian", "--apply"])
  const guidePath = join(vaultPath, "00 School Agent.md")
  if (!existsSync(guidePath)) throw new Error("Installed Obsidian command did not create a guide")
  writeFileSync(guidePath, "User-edited guide", "utf8")
  run(executable, ["vault", "obsidian", "--apply"])
  if (readFileSync(guidePath, "utf8") !== "User-edited guide") {
    throw new Error("Installed Obsidian command overwrote a user note")
  }
  writeFileSync(join(vaultPath, "example.md"), "# Synthetic reading", "utf8")
  const readingDestination = join(temporaryDirectory, "reading copies")
  const readingArguments = ["vault", "reading-copy", "--destination", readingDestination]
  run(executable, readingArguments)
  if (existsSync(readingDestination)) throw new Error("Reading-copy preview wrote files")
  run(executable, [...readingArguments, "--apply"])
  run(executable, [...readingArguments, "--current", "--apply"])
  const readingPath = join(readingDestination, "Current", "example.md.txt")
  if (readFileSync(readingPath, "utf8") !== "# Synthetic reading") {
    throw new Error("Installed Current export did not preserve the synthetic reading")
  }
  run(executable, [...readingArguments, "--current", "--apply"])
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
