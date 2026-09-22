import { randomUUID } from "node:crypto"

import { createGateway, generateText } from "ai"

import type { SchoolConfig } from "../config/index.js"
import { recordModelUsage } from "../models/cost.js"
import { modelMappings } from "../models/index.js"
import type { SchoolIndex } from "../store/db.js"
import type { TriageFunction } from "./retrieve.js"

export class RetrieveTriageError extends Error {
  readonly name = "RetrieveTriageError"
}

function summaryModel(config: SchoolConfig): string {
  const mapping = modelMappings(config).find(
    (candidate) => candidate.key === "models.functions.extractSummary",
  )
  if (mapping === undefined) {
    throw new RetrieveTriageError("No model registry entry for extractSummary")
  }
  return mapping.model
}

/**
 * `index` is optional: callers that only need summaries (with no index in
 * scope, e.g. a bare CLI invocation before sync) can omit it and lose only
 * the usage/cost row, never the summary itself.
 */
export function createGatewayTriage(config: SchoolConfig, index?: SchoolIndex): TriageFunction {
  const model = summaryModel(config)
  const gateway = createGateway()
  return {
    async summarize(input) {
      const result = await generateText({
        model: gateway(model),
        prompt: [
          "Produce a compact factual retrieval summary for this course artifact.",
          `Vault path: ${input.path}`,
          input.content,
        ].join("\n\n"),
      })
      if (index !== undefined) {
        // Each summarized file gets its own row: a fresh run id per call
        // keeps the (sync_run_canvas_id, model, function_name) PK from
        // collapsing distinct summaries of different files into one upsert.
        const generationId = result.providerMetadata?.["gateway"]?.["generationId"]
        recordModelUsage({
          index,
          model,
          functionName: "extractSummary",
          runId: randomUUID(),
          recordedAt: new Date().toISOString(),
          usage: {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
            cachedInputTokens: result.usage.inputTokenDetails.cacheReadTokens ?? undefined,
            generationId: typeof generationId === "string" ? generationId : undefined,
          },
        })
      }
      return result.text
    },
  }
}
