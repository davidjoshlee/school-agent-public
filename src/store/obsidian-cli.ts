import { dirname, join, resolve } from "node:path"
import type { Command } from "commander"

import type { RootOptions } from "../cli.js"
import { loadConfig } from "../config/index.js"
import { openObsidianVault, planObsidianVault, prepareObsidianVault } from "./obsidian.js"
import { pathExists } from "./vault-local-git.js"

export function registerObsidianCommand(vault: Command, program: Command): void {
  const command = vault
    .command("obsidian")
    .description("Inspect Obsidian readiness and file types without moving or uploading files")
    .option("--apply", "create a local getting-started note; preserve existing files/settings")
    .option("--open", "launch the guide in Obsidian after registering the folder in the app")
  command.action(async () => {
    const root = program.opts<RootOptions>()
    const configuration = loadConfig(root.config)
    const options = command.opts<{ readonly apply?: boolean; readonly open?: boolean }>()
    const input = {
      root: configuration.vault.path,
      privatePaths: [
        resolve(root.config),
        join(dirname(resolve(root.config)), ".env"),
        configuration.index.path,
      ],
    }
    const plan = await planObsidianVault(input)
    console.log(`Vault stays at: ${plan.root}`)
    console.log("File types (originals stay unchanged):")
    for (const [type, count] of Object.entries(plan.fileTypes).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      console.log(`  ${type}: ${count}`)
    }
    for (const warning of plan.warnings) console.warn(`WARN ${warning}`)
    for (const blocker of plan.blockers) console.error(`BLOCKED ${blocker}`)
    if (plan.blockers.length > 0)
      throw new Error("Vault is not ready for Obsidian sync preparation; no files changed.")
    if (options.apply === true) {
      const result = await prepareObsidianVault(input)
      console.log(`${result.created ? "Created" : "Preserved existing"} guide: ${plan.guidePath}`)
    } else {
      console.log("Preview only; use --apply to create the getting-started note.")
    }
    console.log("First use: in Obsidian, choose Open folder as vault and select the path above.")
    console.log(`Obsidian link (after folder registration): ${plan.uri}`)
    console.log("Sync is not enabled. Read the getting-started guide before connecting devices.")
    if (options.open === true) {
      if (!(await pathExists(plan.guidePath)))
        throw new Error("Prepare the guide with --apply before using --open.")
      await openObsidianVault(plan.uri)
      console.log("Sent the open request to Obsidian; verify the selected vault in the app.")
    }
  })
}
