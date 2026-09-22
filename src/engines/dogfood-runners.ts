/**
 * Shared `AgentRunner` builders for the dogfood draft/co-edit/approve and
 * discuss flows — mirrors assignment-cli.ts's `gatedRunner`/`discussionRunner`
 * (kept separate rather than imported: those are private to that CLI file).
 */
import { join } from "node:path"

import { createGateway, stepCountIs, tool } from "ai"
import { z } from "zod"

import { calculateTool } from "../agents/calculate-tool.js"
import { AISDKAgentRunner } from "../agents/runner.js"
import type { SchoolConfig } from "../config/index.js"
import { functionModel } from "./dogfood-state.js"

// Mirrors assignment-cli.ts's draftMaxSteps: the draft/revise loop makes a few
// batched `calculate` calls, then writes — capped so an over-calling model
// can't balloon the context (the ~30-min dogfood draft). Keep in sync with it.
const draftMaxSteps = 16

export function gatedRunner(
  config: SchoolConfig,
  functionName: "assignmentDraft",
): AISDKAgentRunner {
  const gate = tool({
    description: "Pause a draft for explicit human approval.",
    inputSchema: z.object({ artifact: z.string().optional() }),
    execute: async () => ({ approved: true }),
  })
  return new AISDKAgentRunner({
    runsDir: join(config.vault.path, ".agent-runs"),
    model: createGateway()(functionModel(config, functionName)),
    tools: { assignment_gate: gate, calculate: calculateTool },
    toolApproval: { assignment_gate: "user-approval" },
    stopWhen: stepCountIs(draftMaxSteps),
  })
}

export function discussionRunner(config: SchoolConfig): AISDKAgentRunner {
  return new AISDKAgentRunner({
    runsDir: join(config.vault.path, ".agent-runs"),
    model: createGateway()(functionModel(config, "assignmentDiscuss")),
    tools: {},
  })
}
