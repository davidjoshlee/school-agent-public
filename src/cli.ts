import { Command, CommanderError } from "commander"

import { registerAuthCommand } from "./canvas/auth-cli.js"
import { registerIngestCommand } from "./canvas/ingest-cli.js"
import { registerOnboardCommand } from "./canvas/onboard-cli.js"
import { registerSyncCommand } from "./canvas/sync-cli.js"
import { registerConfigCommand } from "./config/config-cli.js"
import { registerSetupCommand } from "./config/setup-cli.js"
import { registerAssignmentCommand } from "./engines/assignment-cli.js"
import { registerCompareCommand } from "./engines/compare-cli.js"
import { registerCostCommand } from "./engines/cost-cli.js"
import { registerDogfoodCommand } from "./engines/dogfood-cli.js"
import { registerGateM1Command } from "./engines/gate-m1-cli.js"
import { registerGuidanceCommand } from "./engines/guidance-cli.js"
import { registerHomeworkCommand } from "./engines/homework-cli.js"
import { registerPrepCommand } from "./engines/prep-cli.js"
import { registerSimulateCommand } from "./engines/simulate-cli.js"
import { registerTimelineCommand } from "./engines/timeline-cli.js"
import { registerModelsCommand } from "./models/models-cli.js"
import { registerVaultCommand } from "./store/vault-cli.js"

export type RootOptions = {
  readonly config: string
  readonly model?: string
}

export function createProgram(): Command {
  const program = new Command()
    .name("school")
    .description("School agent CLI")
    .option("--config <path>", "path to school.config.json", "school.config.json")
    .option("--model <model-id>", "override every model mapping for this run")
    .exitOverride()

  registerAssignmentCommand(program)
  registerAuthCommand(program)
  registerCompareCommand(program)
  registerConfigCommand(program)
  registerSetupCommand(program)
  registerCostCommand(program)
  registerDogfoodCommand(program)
  registerGateM1Command(program)
  registerGuidanceCommand(program)
  registerHomeworkCommand(program)
  registerIngestCommand(program)
  registerModelsCommand(program)
  registerOnboardCommand(program)
  registerPrepCommand(program)
  registerSimulateCommand(program)
  registerSyncCommand(program)
  registerTimelineCommand(program)
  registerVaultCommand(program)

  return program
}

export async function runCli(arguments_: readonly string[]): Promise<number> {
  try {
    await createProgram().parseAsync(["node", "school", ...arguments_])
    return 0
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0
    if (error instanceof Error) {
      console.error(error.message)
    } else {
      console.error(String(error))
    }
    return 1
  }
}
