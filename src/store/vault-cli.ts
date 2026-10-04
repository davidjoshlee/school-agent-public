import { existsSync } from "node:fs"
import type { Command } from "commander"

import type { RootOptions } from "../cli.js"
import { loadConfig } from "../config/index.js"
import { planIndexReconciliation } from "./index-reconcile-plan.js"
import { registerObsidianCommand } from "./obsidian-cli.js"
import { registerReadingCopyCommand } from "./reading-copy-cli.js"
import {
  executeCourseRootMigration,
  planCourseRootMigration,
} from "./vault-course-root-migration.js"
import { planVaultHealth } from "./vault-health.js"
import { executeVaultMigration, planVaultMigration } from "./vault-migration.js"

export function registerVaultCommand(program: Command): void {
  const vault = program.command("vault").description("Manage the local Markdown vault")
  registerObsidianCommand(vault, program)
  registerReadingCopyCommand(vault, program)
  const reconcile = vault
    .command("reconcile-index")
    .description("Classify missing indexed paths and suggest safe relinks (read-only)")
    .option("--json", "print the complete local reconciliation plan as JSON")
  reconcile.action(async () => {
    const configuration = loadConfig(program.opts<RootOptions>().config)
    const plan = await planIndexReconciliation({
      vaultRoot: configuration.vault.path,
      indexPath: configuration.index.path,
    })
    if (reconcile.opts<{ readonly json?: boolean }>().json === true) {
      console.log(JSON.stringify(plan, null, 2))
      return
    }
    const counts = new Map<string, number>()
    for (const finding of plan.findings) {
      counts.set(finding.status, (counts.get(finding.status) ?? 0) + 1)
    }
    console.log(`Index reconciliation: ${plan.findings.length} missing indexed path(s). Read-only.`)
    for (const [status, count] of counts) console.log(`${status}: ${count}`)
    console.log(`${plan.proposedRelinks} unique local relink candidate(s); no changes made.`)
    console.log(
      "Use --json to review individual candidates. Applying relinks is not supported yet.",
    )
  })

  const health = vault
    .command("health")
    .description("Audit vault and index consistency (read-only dry run)")
    .option("--json", "print the complete audit and repair plan as JSON")
  health.action(async () => {
    const configuration = loadConfig(program.opts<RootOptions>().config)
    const plan = await planVaultHealth({
      root: configuration.vault.path,
      indexPath: configuration.index.path,
    })
    if (health.opts<{ readonly json?: boolean }>().json === true) {
      console.log(JSON.stringify(plan, null, 2))
    } else {
      console.log(
        `Vault health: ${plan.issues.length} issue(s). Read-only dry run; no changes made.`,
      )
      for (const issue of plan.issues) {
        console.log(`${issue.kind.toUpperCase()} ${issue.path}: ${issue.detail}`)
      }
      if (plan.issues.length === 0) console.log("No vault health issues found.")
      if (plan.repairPlan.length > 0) {
        console.log("Suggested review actions (not applied):")
        for (const action of plan.repairPlan) console.log(`- ${action.kind}: ${action.detail}`)
      }
    }
    if (plan.issues.length > 0)
      throw new Error(`Vault health found ${plan.issues.length} issue(s).`)
  })

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
    .description("Plan legacy v2 course roots to human-readable course-name roots")
    .option("--apply", "apply the planned moves; without this flag nothing is changed")
  migrateRoots.action(async () => {
    const configuration = loadConfig(program.opts<RootOptions>().config)
    const plan = await planCourseRootMigration(configuration.vault.path, configuration.index.path)
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
    if (!plan.ready) throw new Error("Course-root migration has conflicts; nothing moved.")
    if (!existsSync(configuration.index.path)) {
      console.log("No local index or course roots exist; there is nothing to migrate.")
      return
    }
    const moved = await executeCourseRootMigration(plan, configuration.index.path)
    console.log(`Applied course-root migration: moved ${moved.length} course root(s).`)
  })
}
