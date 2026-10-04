import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const packageMetadataPath = fileURLToPath(new URL("../package.json", import.meta.url))
const packageMetadata = JSON.parse(readFileSync(packageMetadataPath, "utf8")) as {
  readonly version: string
}

export function getPackageVersion(): string {
  return packageMetadata.version
}
