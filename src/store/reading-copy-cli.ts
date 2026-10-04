import { dirname, join, resolve } from "node:path"
import type { Command } from "commander"

import type { RootOptions } from "../cli.js"
import { loadConfig } from "../config/index.js"
import { createReadingCopy, planReadingCopy } from "./reading-copy.js"
import { refreshReadingMirror } from "./reading-mirror.js"

export function registerReadingCopyCommand(vault: Command, program: Command): void {
  const command = vault
    .command("reading-copy")
    .description("Export a new one-way reading snapshot; keep working vault and agent state local")
    .requiredOption(
      "--destination <folder>",
      "local output folder, optionally under Google Drive (uploads when Drive syncs)",
    )
    .option("--apply", "write a new dated snapshot; without this flag only show the plan")
    .option("--current", "refresh a persistent Current mirror instead of a dated snapshot")
  command.action(async () => {
    const configPath = resolve(program.opts<RootOptions>().config)
    const configuration = loadConfig(configPath)
    const privatePaths = [configPath, join(dirname(configPath), ".env"), configuration.index.path]
    const options = command.opts<{
      readonly destination: string
      readonly apply?: boolean
      readonly current?: boolean
    }>()
    const plan = await planReadingCopy(configuration.vault.path, options.destination, privatePaths)
    console.log(
      `Reading copy: ${plan.files.length} files, ${(plan.totalBytes / 1024 / 1024).toFixed(1)} MB, ${plan.skipped} excluded entries.`,
    )
    console.log(`Destination: ${plan.destination}`)
    console.log(
      "Excludes hidden folders, operational metadata, simulations, old archives, manifests, and unsupported formats.",
    )
    console.log(
      "Markdown becomes .md.txt for phone preview. The working vault is unchanged. No reverse sync; automatic scheduling is separate.",
    )
    if (options.apply !== true) {
      console.log(
        "Preview only. --apply may upload course material if the destination is cloud-synced; review the account first.",
      )
      return
    }
    if (options.current === true) {
      const result = await refreshReadingMirror(
        configuration.vault.path,
        options.destination,
        (stage) => console.log(stage),
        privatePaths,
      )
      console.log(
        `Current: ${result.updated} updated, ${result.unchanged} unchanged, ${result.recovered} recovered. ${result.path}`,
      )
      return
    }
    const result = await createReadingCopy(
      configuration.vault.path,
      options.destination,
      privatePaths,
    )
    console.log(`Created ${result.copied} files in ${result.path}`)
    console.log(
      "Wait for Drive upload to finish before opening on your phone. Existing snapshots were preserved.",
    )
  })
}
