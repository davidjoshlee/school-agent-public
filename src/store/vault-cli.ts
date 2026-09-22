import type { Command } from "commander"
import { z } from "zod"

import type { RootOptions } from "../cli.js"
import { loadConfig } from "../config/index.js"
import { readOptional } from "../util/fs.js"
import { vaultLayout, vaultPaths } from "./paths.js"

const layoutMetadataSchema = z.object({ layout_version: z.number() })

export function registerVaultCommand(program: Command): void {
  const vault = program.command("vault").description("Manage the local Markdown vault")
  vault
    .command("migrate")
    .description("Check whether the vault layout is up to date")
    .action(async () => {
      const root = program.opts<RootOptions>()
      const configuration = loadConfig(root.config)
      const layoutPath = vaultPaths(configuration.vault.path).metadata.layout
      const raw = await readOptional(layoutPath)
      if (raw === null) {
        console.log("Vault layout metadata not found; treating as not-yet-initialized.")
        return
      }
      let recordedVersion: number
      try {
        recordedVersion = layoutMetadataSchema.parse(JSON.parse(raw)).layout_version
      } catch {
        console.log(
          `Vault layout metadata at ${layoutPath} is unreadable; cannot determine version.`,
        )
        return
      }
      if (recordedVersion === vaultLayout.version) {
        console.log("Vault layout is up to date; no migration required.")
        return
      }
      console.log(
        `Recorded layout v${recordedVersion} predates current v${vaultLayout.version}; no migration step is implemented yet.`,
      )
    })
}
