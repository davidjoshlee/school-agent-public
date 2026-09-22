import { join } from "node:path"

import { createGateway } from "ai"
import type { Command } from "commander"

import { AISDKAgentRunner } from "../agents/runner.js"
import { loadConfig } from "../config/index.js"
import { checkModelMappings, loadGatewayCatalog, modelMappings } from "../models/index.js"
import { createSchoolIndex } from "../store/db.js"
import { generatePrepBrief, type PrepPeriod } from "./prep.js"
import { createGatewayTriage } from "./retrieve-triage.js"

type RootOptions = { readonly config: string; readonly model?: string }
type PrepOptions = {
  readonly week?: string
  readonly session?: string
  readonly model?: string
  readonly catalog?: string
}

export class PrepCommandError extends Error {
  readonly name = "PrepCommandError"
}

export function registerPrepCommand(program: Command): void {
  const prep = program
    .command("prep <course>")
    .description("Generate an auto-delivered course prep brief")
    .option("--week <week>", "course week to prepare")
    .option("--session <session>", "class session to prepare")
    .option("--model <model-id>", "override the prep model for this run")
    .option("--catalog <path>", "recorded AI Gateway catalog for models-check preflight")
  prep.action(async (courseCode: string) => {
    const root = program.opts<RootOptions>()
    const options = prep.opts<PrepOptions>()
    const configuration = loadConfig(root.config)
    const modelOverride = options.model ?? root.model
    preflightModels(configuration, modelOverride, options.catalog)
    const period = prepPeriod(options, configuration.prep.granularity)
    const index = createSchoolIndex({ path: configuration.index.path })
    try {
      const course = index.courseByCanvasId(courseCode) ?? index.courseByCode(courseCode)
      if (course === null) {
        throw new PrepCommandError(
          `Course not found in index: ${courseCode} (tried both Canvas course id and course code). Run school sync first.`,
        )
      }
      const model = prepModel(configuration, modelOverride)
      const gateway = createGateway()
      const result = await generatePrepBrief({
        vaultRoot: configuration.vault.path,
        config: configuration,
        course: {
          code: course.courseCode,
          canvasId: course.canvasId,
          canvasUrl: new URL(
            `/courses/${course.canvasId}`,
            configuration.canvas.baseUrl,
          ).toString(),
          aiPolicy: configuration.aiPolicyDefault,
        },
        period,
        ...(modelOverride === undefined ? {} : { modelOverride }),
        index,
        runner: new AISDKAgentRunner({
          runsDir: join(configuration.vault.path, ".agent-runs"),
          model: gateway(model),
          tools: {},
        }),
        triage: createGatewayTriage(configuration, index),
      })
      console.log(result.path)
    } finally {
      index.close()
    }
  })
}

function prepPeriod(options: PrepOptions, granularity: "week" | "session"): PrepPeriod {
  if (options.week !== undefined && options.session !== undefined) {
    throw new PrepCommandError("Use either --week or --session, not both.")
  }
  if (options.week !== undefined) {
    return { kind: "week", value: options.week }
  }
  if (options.session !== undefined) {
    return { kind: "session", value: options.session }
  }
  if (granularity === "session") {
    throw new PrepCommandError("Session granularity requires --session <session>.")
  }
  return { kind: "week", value: "current" }
}

function prepModel(
  configuration: ReturnType<typeof loadConfig>,
  modelOverride: string | undefined,
): string {
  const mapping = modelMappings(configuration, modelOverride).find(
    (candidate) => candidate.key === "models.functions.prepBrief",
  )
  if (mapping === undefined) {
    throw new PrepCommandError("Missing models.functions.prepBrief mapping.")
  }
  return mapping.model
}

function preflightModels(
  configuration: ReturnType<typeof loadConfig>,
  modelOverride: string | undefined,
  catalogPath: string | undefined,
): void {
  if (catalogPath === undefined) {
    return
  }
  const invalid = checkModelMappings(
    modelMappings(configuration, modelOverride),
    loadGatewayCatalog(catalogPath),
  ).filter((mapping) => mapping.promptCaching === null)
  if (invalid.length === 0) {
    return
  }
  const prepMapping = invalid.find((mapping) => mapping.key === "models.functions.prepBrief")
  const mapping = prepMapping ?? invalid[0]
  if (mapping === undefined) {
    throw new PrepCommandError("Model registry check failed.")
  }
  throw new PrepCommandError(`Invalid model mapping: ${mapping.key} -> ${mapping.model}`)
}
