import type { Command } from "commander"

import type { RootOptions } from "../cli.js"
import { ConfigError, loadConfig } from "../config/index.js"
import { checkModelMappings, loadGatewayCatalog, modelMappings } from "./index.js"

type CheckOptions = {
  readonly catalog: string
}

function printMappings(mappings: ReturnType<typeof modelMappings>): void {
  console.log("Function\tModel")
  for (const mapping of mappings) {
    console.log(`${mapping.key}\t${mapping.model}`)
  }
}

export function registerModelsCommand(program: Command): void {
  const models = program.command("models").description("Inspect model assignments")
  models
    .command("map")
    .description("Print the function-to-model registry")
    .action(() => {
      const options = program.opts<RootOptions>()
      printMappings(modelMappings(loadConfig(options.config), options.model))
    })
  const check = models
    .command("check")
    .description("Check mappings against a recorded AI Gateway catalog")
    .requiredOption("--catalog <path>", "path to a recorded AI Gateway catalog")
  check.action(() => {
    const options = program.opts<RootOptions>()
    const checkOptions = check.opts<CheckOptions>()
    const mappings = modelMappings(loadConfig(options.config), options.model)
    const catalog = loadGatewayCatalog(checkOptions.catalog)
    const checkedMappings = checkModelMappings(mappings, catalog)
    console.log("AI Gateway catalog:")
    for (const model of catalog.models) {
      console.log(`${model.id}\tprompt caching: ${model.promptCaching}`)
    }
    console.log("Mapped models:")
    for (const checkedMapping of checkedMappings) {
      const caching =
        checkedMapping.promptCaching === null ? "unknown" : String(checkedMapping.promptCaching)
      console.log(`${checkedMapping.key}\t${checkedMapping.model}\tprompt caching: ${caching}`)
    }
    const invalidMappings = checkedMappings.filter((mapping) => mapping.promptCaching === null)
    if (invalidMappings.length > 0) {
      for (const invalidMapping of invalidMappings) {
        console.error(`Invalid model mapping: ${invalidMapping.key} -> ${invalidMapping.model}`)
      }
      throw new ConfigError("Model registry check failed")
    }
    console.log("Model registry check passed")
  })
}
