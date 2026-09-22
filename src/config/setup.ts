import { accessSync, constants, existsSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { z } from "zod"

import { loadConfig } from "./index.js"

export const setupOptionsSchema = z.strictObject({
  canvasUrl: z.url().refine(
    (value) => {
      const url = new URL(value)
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
    },
    { message: "Use an HTTPS Canvas URL without credentials, query parameters, or fragments" },
  ),
})

export type SetupOptions = z.infer<typeof setupOptionsSchema>

const envTemplate = `# Canvas personal access token. Keep this file private; never commit it.\nCANVAS_TOKEN=\n\n# Optional: needed only for AI-powered prep and drafting.\nAI_GATEWAY_API_KEY=\n`

export class SetupError extends Error {
  readonly name = "SetupError"
}

export function setupPaths(configPath: string): {
  readonly config: string
  readonly environment: string
} {
  const config = resolve(configPath)
  return { config, environment: join(dirname(config), ".env") }
}

export function createStarterConfig(
  configPath: string,
  options: SetupOptions,
  homeDirectory = homedir(),
): { readonly configPath: string; readonly environmentPath: string } {
  const paths = setupPaths(configPath)
  if (existsSync(paths.config) || existsSync(paths.environment)) {
    const existing = [paths.config, paths.environment].filter(existsSync)
    throw new SetupError(
      `Setup refused: already exists: ${existing.join(", ")}. Nothing was changed.`,
    )
  }

  const configuration = {
    canvas: { baseUrl: options.canvasUrl, tokenEnv: "CANVAS_TOKEN" },
    vault: { path: join(homeDirectory, "school-vault"), gitInit: false },
    index: { path: join(homeDirectory, ".local/share/school-agent/index.db") },
    courses: { mode: "list", allowlist: [], pilotCourseId: null },
    cost: { maxMonthlySpendUSD: 15 },
  }

  try {
    writeFileSync(paths.config, `${JSON.stringify(configuration, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    writeFileSync(paths.environment, envTemplate, { encoding: "utf8", flag: "wx", mode: 0o600 })
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new SetupError(
        "Setup refused because a setup file already exists. Nothing was overwritten.",
      )
    }
    throw error
  }
  return { configPath: paths.config, environmentPath: paths.environment }
}

export type DoctorFinding = {
  readonly level: "ok" | "warning" | "error"
  readonly message: string
}

export type DoctorReport = {
  readonly findings: readonly DoctorFinding[]
  readonly healthy: boolean
}

export function doctor(
  configPath: string,
  options: { readonly syncOnly: boolean },
  environment: NodeJS.ProcessEnv = process.env,
  nodeVersion = process.versions.node,
): DoctorReport {
  const findings: DoctorFinding[] = []
  const major = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10)
  if (Number.isInteger(major) && major >= 22) {
    findings.push({ level: "ok", message: `Node.js ${nodeVersion} (requires >=22)` })
  } else {
    findings.push({
      level: "error",
      message: `Node.js ${nodeVersion}; install Node.js 22 or newer.`,
    })
  }

  let configuration: ReturnType<typeof loadConfig>
  try {
    configuration = loadConfig(configPath)
    findings.push({ level: "ok", message: `Config is valid: ${resolve(configPath)}` })
  } catch (error) {
    findings.push({
      level: "error",
      message: `Config is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`,
    })
    return { findings, healthy: false }
  }

  const tokenName = configuration.canvas.tokenEnv
  findings.push(
    present(environment[tokenName])
      ? { level: "ok", message: `Canvas credential is present (${tokenName}).` }
      : {
          level: "error",
          message: `Canvas credential is missing; set ${tokenName} before running sync.`,
        },
  )
  const llmFinding: DoctorFinding = present(environment["AI_GATEWAY_API_KEY"])
    ? { level: "ok", message: "AI credential is present." }
    : {
        level: "warning",
        message: options.syncOnly
          ? "AI credential is absent (fine for sync-only use)."
          : "AI credential is absent; set AI_GATEWAY_API_KEY before prep or draft.",
      }
  findings.push(llmFinding)
  findings.push(writableDirectoryFinding("Vault directory", configuration.vault.path))
  findings.push(writableDirectoryFinding("Index directory", dirname(configuration.index.path)))
  return { findings, healthy: !findings.some((finding) => finding.level === "error") }
}

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== ""
}

function writableDirectoryFinding(label: string, target: string): DoctorFinding {
  const directory = nearestExistingDirectory(target)
  try {
    if (!statSync(directory).isDirectory()) throw new Error("Path is not a directory")
    accessSync(directory, constants.W_OK)
    return { level: "ok", message: `${label} is writable via ${directory}.` }
  } catch {
    return {
      level: "error",
      message: `${label} is not writable (${directory}); choose a writable local path in school.config.json.`,
    }
  }
}

function nearestExistingDirectory(target: string): string {
  let candidate = resolve(target)
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) return candidate
    candidate = parent
  }
  return candidate
}
