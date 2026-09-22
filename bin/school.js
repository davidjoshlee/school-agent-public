#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

function configPathFromArguments(arguments_) {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === "--config") {
      const value = arguments_[index + 1]
      if (value !== undefined) {
        return resolve(value)
      }
    }
    if (argument.startsWith("--config=")) {
      return resolve(argument.slice("--config=".length))
    }
  }
  return resolve("school.config.json")
}

function dotenvEntries(content) {
  const entries = []
  for (const rawLine of content.replace(/^\uFEFF/, "").split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) {
      continue
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line)
    if (match === null) {
      continue
    }
    const key = match[1]
    let value = match[2].trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
      if (rawLine.includes('"')) {
        value = value.replace(/\\n/gu, "\n").replace(/\\r/gu, "\r")
      }
    } else {
      value = value.replace(/\s+#.*$/u, "").trimEnd()
    }
    entries.push([key, value])
  }
  return entries
}

/**
 * Load only missing variables from the .env beside the chosen configuration.
 * The caller's environment always wins, including an explicitly empty value.
 */
export function loadEnvironmentForConfig(configPath, environment = process.env) {
  const environmentPath = resolve(dirname(configPath), ".env")
  if (!existsSync(environmentPath)) {
    return environmentPath
  }
  for (const [key, value] of dotenvEntries(readFileSync(environmentPath, "utf8"))) {
    if (!Object.hasOwn(environment, key)) {
      environment[key] = value
    }
  }
  return environmentPath
}

async function main() {
  loadEnvironmentForConfig(configPathFromArguments(process.argv.slice(2)))
  await import("../dist/index.js")
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  await main()
}
