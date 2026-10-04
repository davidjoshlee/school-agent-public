import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

/** Resolve one configuration path for both command execution and setup. */
export function resolveConfigPath(
  arguments_: readonly string[],
  cwd = process.cwd(),
  homeDirectory = homedir(),
): string {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === "--config") {
      const value = arguments_[index + 1]
      if (value !== undefined) return resolve(cwd, value)
    }
    if (argument?.startsWith("--config=")) {
      return resolve(cwd, argument.slice("--config=".length))
    }
  }

  const legacyPath = resolve(cwd, "school.config.json")
  if (existsSync(legacyPath)) return legacyPath
  return join(homeDirectory, ".config", "school-agent", "school.config.json")
}

/** Load missing environment values from the .env beside the selected config. */
export function loadEnvironmentForConfig(
  configPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const environmentPath = join(dirname(resolve(configPath)), ".env")
  if (!existsSync(environmentPath)) return environmentPath
  for (const [key, value] of dotenvEntries(readFileSync(environmentPath, "utf8"))) {
    if (!Object.hasOwn(environment, key)) environment[key] = value
  }
  return environmentPath
}

function dotenvEntries(content: string): [string, string][] {
  const entries: [string, string][] = []
  for (const rawLine of content.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line)
    if (match === null) continue
    const key = match[1]
    const rawValue = match[2]
    if (key === undefined || rawValue === undefined) continue
    let value = rawValue.trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
      if (rawLine.includes('"')) value = value.replace(/\\n/gu, "\n").replace(/\\r/gu, "\r")
    } else {
      value = value.replace(/\s+#.*$/u, "").trimEnd()
    }
    entries.push([key, value])
  }
  return entries
}
