import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"

import { createGateway, stepCountIs, tool } from "ai"
import type { Command } from "commander"
import { z } from "zod"

import { calculateTool } from "../agents/calculate-tool.js"
import { AISDKAgentRunner } from "../agents/runner.js"
import { loadConfig, type SchoolConfig } from "../config/index.js"
import { modelMappings } from "../models/index.js"
import { createSchoolIndex } from "../store/db.js"
import { vaultLayout } from "../store/paths.js"
import { parseVaultDocument } from "../store/vault.js"
import { readDirectory, readOptional } from "../util/fs.js"
import {
  approveAssignment,
  discussAssignment,
  draftAssignment,
  groupCategoryFromContent,
  reviseAssignment,
} from "./assignment.js"
import { createGatewayTriage } from "./retrieve-triage.js"

type RootOptions = { readonly config: string; readonly model?: string }
type DraftOptions = { readonly discuss?: string }
type LocatedAssignment = {
  readonly course: { readonly code: string; readonly canvasId: string; readonly canvasUrl: string }
  readonly assignment: {
    readonly canvasId: string
    readonly title: string
    readonly canvasUrl: string
    readonly groupCategoryId: string | null
  }
}

export class AssignmentCommandError extends Error {
  readonly name = "AssignmentCommandError"
}

export function registerAssignmentCommand(program: Command): void {
  const draft = program
    .command("draft <assignment>")
    .description("Create a gated first-pass assignment draft or discuss it without versioning")
    .option("--discuss <message>", "discuss the assignment without creating a new version")
  draft.action(async (identifier: string) => {
    const root = program.opts<RootOptions>()
    const options = draft.opts<DraftOptions>()
    const configuration = loadConfig(root.config)
    if (options.discuss !== undefined) {
      const located = await locateAssignment(configuration.vault.path, identifier)
      const result = await discussAssignment({
        vaultRoot: configuration.vault.path,
        config: configuration,
        course: located.course,
        assignment: located.assignment,
        runner: discussionRunner(configuration, root.model),
        message: options.discuss,
        triage: createGatewayTriage(configuration),
      })
      console.log(result.path)
      return
    }
    const result = await runAssignmentDraft(configuration, root.model, identifier)
    console.log(`${result.runId}\t${result.path}`)
  })

  const revise = program
    .command("revise <run-id> [feedback]")
    .description("Create the next gated version from user edits and feedback")
  revise.action(async (runId: string, feedback: string | undefined) => {
    const root = program.opts<RootOptions>()
    const configuration = loadConfig(root.config)
    const index = createSchoolIndex({ path: configuration.index.path })
    try {
      const result = await reviseAssignment({
        vaultRoot: configuration.vault.path,
        config: configuration,
        runner: gatedRunner(configuration, root.model),
        runId,
        feedback: feedback ?? "",
        index,
        triage: createGatewayTriage(configuration, index),
      })
      console.log(`${result.runId}\t${result.path}`)
    } finally {
      index.close()
    }
  })

  const approve = program
    .command("approve <run-id>")
    .description("Approve a gated assignment draft")
  approve.action(async (runId: string) => {
    const root = program.opts<RootOptions>()
    const configuration = loadConfig(root.config)
    const result = await approveAssignment({
      vaultRoot: configuration.vault.path,
      config: configuration,
      runner: gatedRunner(configuration, root.model),
      runId,
    })
    console.log(result.path)
  })
}

export type AssignmentDraftRunResult = { readonly runId: string; readonly path: string }

/**
 * The single entry point for "produce a gated draft for this assignment" —
 * shared by `draft <assignment>` and `homework --draft <assignment-id>` so
 * the gate, self-review, spend cap, provenance, versioning, and xlsx
 * emission stay wired exactly once.
 */
export async function runAssignmentDraft(
  configuration: SchoolConfig,
  modelOverride: string | undefined,
  identifier: string,
): Promise<AssignmentDraftRunResult> {
  const located = await locateAssignment(configuration.vault.path, identifier)
  const index = createSchoolIndex({ path: configuration.index.path })
  try {
    const result = await draftAssignment({
      vaultRoot: configuration.vault.path,
      config: configuration,
      course: located.course,
      assignment: located.assignment,
      runner: gatedRunner(configuration, modelOverride),
      index,
      triage: createGatewayTriage(configuration, index),
    })
    return { runId: result.runId, path: result.path }
  } finally {
    index.close()
  }
}

// The draft loop makes a few batched `calculate` calls (see draftPrompt, which
// tells the model to compute many values per call), then writes the draft. This
// caps the loop well above what a batched draft needs without letting a model
// that over-calls `calculate` balloon into hundreds of context re-sends (the
// 41-call / 1.35M-token / ~30-min draft the M2 dogfood hit). Prep and discussion
// runners keep the framework default.
const draftMaxSteps = 16

function gatedRunner(config: SchoolConfig, override: string | undefined): AISDKAgentRunner {
  const gate = tool({
    description: "Pause a draft for explicit human approval.",
    inputSchema: z.object({ artifact: z.string().optional() }),
    execute: async () => ({ approved: true }),
  })
  return new AISDKAgentRunner({
    runsDir: join(config.vault.path, ".agent-runs"),
    model: createGateway()(functionModel(config, override, "assignmentDraft")),
    tools: { assignment_gate: gate, calculate: calculateTool },
    toolApproval: { assignment_gate: "user-approval" },
    stopWhen: stepCountIs(draftMaxSteps),
  })
}

function discussionRunner(config: SchoolConfig, override: string | undefined): AISDKAgentRunner {
  return new AISDKAgentRunner({
    runsDir: join(config.vault.path, ".agent-runs"),
    model: createGateway()(functionModel(config, override, "assignmentDiscuss")),
    tools: {},
  })
}

function functionModel(
  config: SchoolConfig,
  override: string | undefined,
  functionName: "assignmentDraft" | "assignmentDiscuss",
): string {
  const mapping = modelMappings(config, override).find(
    (candidate) => candidate.key === `models.functions.${functionName}`,
  )
  if (mapping === undefined) {
    throw new AssignmentCommandError(`Missing models.functions.${functionName} mapping.`)
  }
  return mapping.model
}

async function locateAssignment(vaultRoot: string, identifier: string): Promise<LocatedAssignment> {
  const courses = await readdir(vaultRoot, { withFileTypes: true })
  for (const courseDirectory of courses) {
    if (!courseDirectory.isDirectory() || courseDirectory.name.startsWith(".")) {
      continue
    }
    const courseRoot = join(vaultRoot, courseDirectory.name)
    const indexPath = join(courseRoot, vaultLayout.index)
    const assignmentsPath = join(courseRoot, vaultLayout.assignments)
    const index = await readOptional(indexPath)
    if (index === null) {
      continue
    }
    const courseDocument = parseVaultDocument(index, indexPath)
    const entries = await readDirectory(assignmentsPath)
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue
      }
      const assignmentPath = join(assignmentsPath, entry.name)
      const assignmentDocument = parseVaultDocument(
        await readFile(assignmentPath, "utf8"),
        assignmentPath,
      )
      const slug = basename(entry.name, ".md")
      if (identifier !== assignmentDocument.frontmatter.canvas_id && identifier !== slug) {
        continue
      }
      return {
        course: {
          code: courseDirectory.name,
          canvasId: courseDocument.frontmatter.canvas_id,
          canvasUrl: courseDocument.frontmatter.canvas_url,
        },
        assignment: {
          canvasId: assignmentDocument.frontmatter.canvas_id,
          title: slug,
          canvasUrl: assignmentDocument.frontmatter.canvas_url,
          groupCategoryId: groupCategoryFromContent(assignmentDocument.content),
        },
      }
    }
  }
  throw new AssignmentCommandError(`Assignment not found: ${identifier}. Run school sync first.`)
}
