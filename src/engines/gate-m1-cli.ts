import type { Command } from "commander"

import { loadConfig } from "../config/index.js"
import { runM1Gate } from "./gate-m1.js"

type RootOptions = { readonly config: string }
type M1Options = { readonly run: string; readonly evidence: string }

export function registerGateM1Command(program: Command): void {
  const gate =
    program.commands.find((command) => command.name() === "gate") ??
    program.command("gate").description("Run human-approved delivery gates")
  const m1 = gate
    .command("m1")
    .description("Package an existing simulation run for M1 human verification and stop")
    .requiredOption(
      "--run <run-id>",
      "existing simulation course-week directory name (e.g. strat-101-2025-01-08)",
    )
    .option(
      "--evidence <directory>",
      "directory for the local M1 verification bundle",
      "docs/evidence",
    )
  m1.action(async () => {
    const root = program.opts<RootOptions>()
    const options = m1.opts<M1Options>()
    const configuration = loadConfig(root.config)
    const result = await runM1Gate({
      vaultPath: configuration.vault.path,
      indexPath: configuration.index.path,
      runId: options.run,
      evidenceDirectory: options.evidence,
    })
    console.log(`M1 bundle written: ${result.bundlePath}`)
    console.log("M1 ritual (~20 minutes):")
    console.log("1. Read the output index and comparison for each simulated week.")
    console.log("2. Score the anchored scorecard yourself; do not auto-score usefulness.")
    console.log("3. Verify leakage is zero and review unknown visibility.")
    console.log("4. Check Canvas due_at plus overrides and list syllabus discrepancies.")
    console.log("5. Record PASS or FAIL, then STOP until the user explicitly passes M1.")
  })
}
