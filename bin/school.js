#!/usr/bin/env node

import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"

async function main() {
  const { loadEnvironmentForConfig, resolveConfigPath } = await import("../dist/config/location.js")
  loadEnvironmentForConfig(resolveConfigPath(process.argv.slice(2)))
  await import("../dist/index.js")
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  await main()
}
