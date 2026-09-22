import { readFileSync } from "node:fs"

import { z } from "zod"

import type { ModelFunction, SchoolConfig } from "../config/index.js"

export const modelFunctions = [
  "extractSummary",
  "prepBrief",
  "assignmentDraft",
  "assignmentDiscuss",
  "coverageCompare",
  "playbookUpdate",
] as const satisfies readonly ModelFunction[]

const gatewayCatalogSchema = z.strictObject({
  models: z.array(z.strictObject({ id: z.string().min(1), promptCaching: z.boolean() })),
})

export type GatewayCatalog = z.infer<typeof gatewayCatalogSchema>
export type ModelMapping = {
  readonly key: string
  readonly model: string
}
export type CheckedModelMapping = ModelMapping & { readonly promptCaching: boolean | null }

export function loadGatewayCatalog(catalogPath: string): GatewayCatalog {
  return gatewayCatalogSchema.parse(JSON.parse(readFileSync(catalogPath, "utf8")))
}

export function modelMappings(
  config: SchoolConfig,
  modelOverride?: string,
): readonly ModelMapping[] {
  const modelForRun = modelOverride ?? null
  return [
    { key: "models.triage", model: modelForRun ?? config.models.triage },
    { key: "models.generation", model: modelForRun ?? config.models.generation },
    ...modelFunctions.map((functionName) => ({
      key: `models.functions.${functionName}`,
      model: modelForRun ?? config.models.functions[functionName],
    })),
  ]
}

export function checkModelMappings(
  mappings: readonly ModelMapping[],
  catalog: GatewayCatalog,
): readonly CheckedModelMapping[] {
  const catalogModels = new Map(catalog.models.map((model) => [model.id, model.promptCaching]))
  return mappings.map((mapping) => ({
    ...mapping,
    promptCaching: catalogModels.get(mapping.model) ?? null,
  }))
}
