import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, it } from "vitest"
import { loadConfig } from "../src/config/index.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

it("accepts local vaults on machines without an iCloud directory", async () => {
  const root = await temporaryDirectory("school-agent-local-path-")
  const home = join(root, "home")
  await mkdir(home)
  const path = join(root, "school.config.json")
  await writeFile(path, JSON.stringify({ vault: { path: "~/school-vault" } }))
  expect(loadConfig(path, home).vault.path).toBe(join(home, "school-vault"))
})
