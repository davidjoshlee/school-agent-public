import { join } from "node:path"

import { createGateway } from "ai"
import type { Command } from "commander"

import { AISDKAgentRunner } from "../agents/runner.js"
import { loadConfig } from "../config/index.js"
import { modelMappings } from "../models/index.js"
import { createSchoolIndex } from "../store/db.js"
import { proposeGuidance } from "./guidance-propose.js"

type RootOptions = { readonly config: string; readonly model?: string }
type ProposeOptions = { readonly model?: string }

export class GuidanceCommandError extends Error {
  readonly name = "GuidanceCommandError"
}

export function registerGuidanceCommand(program: Command): void {
  const guidance =
    program.commands.find((command) => command.name() === "guidance") ??
    program.command("guidance").description("Per-class prep-guidance authoring")
  const propose = guidance
    .command("propose <course>")
    .description(
      "Draft guidance/prep-guidance.proposed.md for human review — never touches the user-owned prep-guidance.md",
    )
    .option("--model <model-id>", "override the playbookUpdate model for this run")
  propose.action(async (courseCode: string) => {
    const root = program.opts<RootOptions>()
    const options = propose.opts<ProposeOptions>()
    const configuration = loadConfig(root.config)
    const modelOverride = options.model ?? root.model
    const index = createSchoolIndex({ path: configuration.index.path })
    try {
      const course = index.courseByCanvasId(courseCode) ?? index.courseByCode(courseCode)
      if (course === null) {
        throw new GuidanceCommandError(
          `Course not found in index: ${courseCode} (tried both Canvas course id and course code). Run school sync first.`,
        )
      }
      const model = playbookUpdateModel(configuration, modelOverride)
      const gateway = createGateway()
      const result = await proposeGuidance({
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
        ...(modelOverride === undefined ? {} : { modelOverride }),
        index,
        runner: new AISDKAgentRunner({
          runsDir: join(configuration.vault.path, ".agent-runs"),
          model: gateway(model),
          tools: {},
        }),
      })
      console.log(result.path)
      console.log(
        "This is a PROPOSAL only. Review it, then rename/merge it into guidance/prep-guidance.md yourself if you want the engines to use it.",
      )
    } finally {
      index.close()
    }
  })
}

function playbookUpdateModel(
  configuration: ReturnType<typeof loadConfig>,
  modelOverride: string | undefined,
): string {
  const mapping = modelMappings(configuration, modelOverride).find(
    (candidate) => candidate.key === "models.functions.playbookUpdate",
  )
  if (mapping === undefined) {
    throw new GuidanceCommandError("Missing models.functions.playbookUpdate mapping.")
  }
  return mapping.model
}
