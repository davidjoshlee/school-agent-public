import type { Command } from "commander"

import { loadConfig } from "../config/index.js"
import { compareSimulation } from "./compare.js"

type RootOptions = { readonly config: string }

export function registerCompareCommand(program: Command): void {
  program
    .command("compare <run-id>")
    .description(
      "Compare a simulation course-week directory (e.g. strat-101-2025-01-08) against the pilot's local ground truth",
    )
    .action(async (runId: string) => {
      const root = program.opts<RootOptions>()
      const result = await compareSimulation({ config: loadConfig(root.config), runId })
      console.log(`${result.comparisonPath}\t${result.scorecardPath}`)
    })
}
