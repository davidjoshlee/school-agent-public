import type { Command } from "commander"

import type { RootOptions } from "../cli.js"
import { loadConfig } from "../config/index.js"
import { executeVaultMigration, planVaultMigration } from "./vault-migration.js"

export function registerVaultCommand(program: Command): void {
  const vault = program.command("vault").description("Manage the local Markdown vault")
  const migrate = vault
    .command("migrate")
    .description("Plan a v1 -> v2 vault migration (dry-run by default)")
    .option("--apply", "apply the migration after planning; without this flag nothing is changed")
  migrate.action(async () => {
    const root = program.opts<RootOptions>()
    const configuration = loadConfig(root.config)
    const options = migrate.opts<{ readonly apply?: boolean }>()
    const plan = await planVaultMigration({ root: configuration.vault.path })
    console.log(
      `Vault migration v${plan.sourceVersion} -> v${plan.targetVersion}: ${plan.moves.length} move(s), ${plan.conflicts.length} conflict(s).`,
    )
    for (const action of plan.actions) {
      const verb = action.kind === "move" ? "MOVE" : action.kind.toUpperCase()
      console.log(
        `${verb} ${action.sourceRelative} -> ${action.destinationRelative} (${action.reason})`,
      )
    }
    for (const warning of plan.warnings) console.warn(`WARN ${warning}`)
    if (options.apply !== true) {
      console.log("Dry run only; pass --apply to move files and update _meta/layout.json.")
      return
    }
    const result = await executeVaultMigration(plan)
    console.log(`Applied migration: moved ${result.moved.length} file(s).`)
  })
}
