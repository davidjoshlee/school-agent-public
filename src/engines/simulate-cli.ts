import { join } from "node:path"

import { createGateway, stepCountIs, tool } from "ai"
import type { Command } from "commander"
import { z } from "zod"

import { calculateTool } from "../agents/calculate-tool.js"
import { AISDKAgentRunner } from "../agents/runner.js"
import { loadConfig, type SchoolConfig } from "../config/index.js"
import { modelMappings } from "../models/index.js"
import { createGatewayTriage } from "./retrieve-triage.js"
import { runSimulation, SimulationError } from "./simulate.js"

type RootOptions = { readonly config: string; readonly model?: string }
type SimulationOptions = {
  readonly pilot: boolean
  readonly weeks: string
  readonly module?: string
}

export function registerSimulateCommand(program: Command): void {
  const simulate = program
    .command("simulate")
    .description("Replay a pilot snapshot behind an as-of clock without contacting Canvas")
    .requiredOption("--pilot", "replay the configured pilot course")
    .requiredOption("--weeks <start>..<end>", "inclusive ISO-date window")
    .option("--module <canvas-id>", "draft only the assignments a single module references")
  simulate.action(async () => {
    const root = program.opts<RootOptions>()
    const options = simulate.opts<SimulationOptions>()
    if (!options.pilot) {
      throw new SimulationError("Simulation requires --pilot")
    }
    const configuration = loadConfig(root.config)
    const runners = simulationRunners(configuration, root.model)
    const result = await runSimulation({
      config: configuration,
      weeks: options.weeks,
      runners,
      triage: createGatewayTriage(configuration),
      ...(options.module === undefined ? {} : { moduleCanvasId: options.module }),
    })
    for (const runDir of result.runDirs) {
      console.log(runDir)
    }
  })
}

function simulationRunners(
  config: SchoolConfig,
  override: string | undefined,
): { readonly prep: AISDKAgentRunner; readonly assignment: AISDKAgentRunner } {
  const runsDir = join(config.vault.path, "_simulations", ".agent-runs")
  const gateway = createGateway()
  return {
    prep: new AISDKAgentRunner({
      runsDir,
      model: gateway(modelFor(config, override, "prepBrief")),
      tools: {},
    }),
    assignment: new AISDKAgentRunner({
      runsDir,
      model: gateway(modelFor(config, override, "assignmentDraft")),
      tools: {
        assignment_gate: tool({
          description: "Pause a simulation draft at the approval gate.",
          inputSchema: z.object({ artifact: z.string().optional() }),
          execute: async () => ({ approved: true }),
        }),
        calculate: calculateTool,
      },
      toolApproval: { assignment_gate: "user-approval" },
      // Mirrors assignment-cli.ts's gatedRunner: the draft loop makes a few
      // batched `calculate` calls, then writes — capped so an over-calling model
      // can't balloon the context. Prep keeps the default.
      stopWhen: stepCountIs(16),
    }),
  }
}

function modelFor(
  config: SchoolConfig,
  override: string | undefined,
  functionName: "prepBrief" | "assignmentDraft",
): string {
  const mapping = modelMappings(config, override).find(
    (candidate) => candidate.key === `models.functions.${functionName}`,
  )
  if (mapping === undefined) {
    throw new SimulationError(`Missing models.functions.${functionName} mapping.`)
  }
  return mapping.model
}
