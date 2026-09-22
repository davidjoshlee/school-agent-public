import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDirectory, "..")
const distDirectory = resolve(projectRoot, "dist")

rmSync(distDirectory, { recursive: true, force: true })
mkdirSync(distDirectory, { recursive: true })

const compiler = spawnSync(process.execPath, ["./node_modules/typescript/bin/tsc"], {
  cwd: projectRoot,
  stdio: "inherit",
})
if (compiler.status !== 0) {
  process.exitCode = compiler.status ?? 1
} else {
  await import("./copy-runtime-assets.mjs")
}
