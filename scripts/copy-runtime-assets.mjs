import { cpSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDirectory, "..")
const destination = resolve(projectRoot, "dist", "config")

mkdirSync(destination, { recursive: true })
cpSync(resolve(projectRoot, "config"), destination, { recursive: true })
