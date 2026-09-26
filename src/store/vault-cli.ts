import type { Command } from "commander"

import type { RootOptions } from "../cli.js"
import { loadConfig } from "../config/index.js"
import {
  executeCourseRootMigration,
  planCourseRootMigration,
} from "./vault-course-root-migration.js"
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

  const migrateRoots = vault
    .command("migrate-roots")
    .description("Plan legacy v2 course-code root moves to stable Canvas-ID roots")
    .option("--apply", "apply the planned moves; without this flag nothing is changed")
  migrateRoots.action(async () => {
    const configuration = loadConfig(program.opts<RootOptions>().config)
    const plan = await planCourseRootMigration(configuration.vault.path)
    console.log(
      `Course-root migration: ${plan.moves.length} move(s), ${plan.conflicts.length} conflict(s).`,
    )
    for (const move of plan.moves) {
      console.log(`MOVE ${move.source} -> ${move.destination}`)
    }
    for (const conflict of plan.conflicts) console.error(`CONFLICT ${conflict}`)
    if (migrateRoots.opts<{ readonly apply?: boolean }>().apply !== true) {
      console.log("Dry run only; pass --apply to move course roots and rebase the local index.")
      return
    }
    const moved = await executeCourseRootMigration(plan, configuration.index.path)
    console.log(`Applied course-root migration: moved ${moved.length} course root(s).`)
  })
}
