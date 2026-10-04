import { createGateway, generateText } from "ai"

import type { SchoolConfig } from "../config/index.js"
import { modelMappings } from "./index.js"

const catalogUrl = "https://ai-gateway.vercel.sh/v1/models"
const timeoutMs = 10_000

export type AiReadinessFinding = {
  readonly level: "ok" | "error"
  readonly message: string
}

export type AiReadinessReport = {
  readonly findings: readonly AiReadinessFinding[]
  readonly healthy: boolean
}

type CatalogModel = { readonly id: string; readonly type: string }

export type AiReadinessDependencies = {
  readonly fetchCatalog: (signal: AbortSignal) => Promise<readonly CatalogModel[]>
  readonly generate: (modelId: string, apiKey: string, signal: AbortSignal) => Promise<string>
}

const liveDependencies: AiReadinessDependencies = {
  async fetchCatalog(signal) {
    const response = await fetch(catalogUrl, { signal })
    if (!response.ok) throw new CatalogRequestError()
    const payload: unknown = await response.json()
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("data" in payload) ||
      !Array.isArray(payload.data)
    ) {
      throw new CatalogRequestError()
    }
    return payload.data.filter(isCatalogModel)
  },
  async generate(modelId, apiKey, signal) {
    const gateway = createGateway({ apiKey })
    const result = await generateText({
      model: gateway(modelId),
      prompt: "Reply with READY.",
      maxOutputTokens: 16,
      maxRetries: 0,
      timeout: timeoutMs,
      abortSignal: signal,
    })
    return result.text
  },
}

class CatalogRequestError extends Error {
  readonly name = "CatalogRequestError"
}

class EmptyGenerationError extends Error {
  readonly name = "EmptyGenerationError"
}

function isCatalogModel(value: unknown): value is CatalogModel {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "type" in value &&
    typeof value.type === "string"
  )
}

function configuredModelIds(config: SchoolConfig, modelOverride?: string): readonly string[] {
  return [...new Set(modelMappings(config, modelOverride).map(({ model }) => model))]
}

export async function checkAiReadiness(
  config: SchoolConfig,
  apiKey: string | undefined,
  dependencies: AiReadinessDependencies = liveDependencies,
  modelOverride?: string,
): Promise<AiReadinessReport> {
  if (apiKey === undefined || apiKey.trim() === "") {
    return {
      findings: [
        {
          level: "error",
          message:
            "AI Gateway key is missing or blank; set AI_GATEWAY_API_KEY in the environment or adjacent .env file.",
        },
      ],
      healthy: false,
    }
  }

  let catalog: readonly CatalogModel[]
  try {
    catalog = await dependencies.fetchCatalog(AbortSignal.timeout(timeoutMs))
  } catch (error) {
    const category = error instanceof CatalogRequestError ? "catalogue" : classifyFailure(error)
    return {
      findings: [
        {
          level: "error",
          message: `Could not read the public AI Gateway model catalogue (${category}). Check the network and try again.`,
        },
      ],
      healthy: false,
    }
  }

  const ids = configuredModelIds(config, modelOverride)
  const catalogById = new Map(catalog.map((model) => [model.id, model]))
  const unavailable = ids.filter((id) => catalogById.get(id)?.type !== "language")
  if (unavailable.length > 0) {
    return {
      findings: unavailable.map((id) => ({
        level: "error",
        message: `Configured text model is unavailable in the public catalogue: ${id}. Choose a current language model in school.config.json.`,
      })),
      healthy: false,
    }
  }

  const findings: AiReadinessFinding[] = [
    {
      level: "ok",
      message: `All ${ids.length} distinct configured text model(s) appear in the public catalogue; this does not verify your key or account access.`,
    },
  ]
  for (const id of ids) {
    try {
      const text = await dependencies.generate(id, apiKey, AbortSignal.timeout(timeoutMs))
      if (text.trim() === "") throw new EmptyGenerationError()
      findings.push({
        level: "ok",
        message: `Authenticated synthetic generation succeeded for ${id}.`,
      })
    } catch (error) {
      findings.push({
        level: "error",
        message: `${id}: ${failureGuidance(classifyFailure(error))}`,
      })
    }
  }
  return { findings, healthy: findings.every((finding) => finding.level === "ok") }
}

type FailureCategory =
  | "authentication"
  | "credits"
  | "rate limit"
  | "model"
  | "empty"
  | "timeout"
  | "network"

function classifyFailure(error: unknown): FailureCategory {
  if (error instanceof EmptyGenerationError) return "empty"
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return "timeout"
  let candidate = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof candidate !== "object" || candidate === null) break
    if ("statusCode" in candidate) {
      const status = candidate.statusCode
      if (status === 401 || status === 403) return "authentication"
      if (status === 402) return "credits"
      if (status === 429) return "rate limit"
      if (status === 400 || status === 404) return "model"
    }
    candidate = "cause" in candidate ? candidate.cause : undefined
  }
  if (error instanceof Error && /timeout|timed out/i.test(error.message)) return "timeout"
  return "network"
}

function failureGuidance(category: FailureCategory): string {
  switch (category) {
    case "authentication":
      return "AI Gateway rejected authentication; check that AI_GATEWAY_API_KEY is valid and active."
    case "credits":
      return "AI Gateway reports insufficient credits or budget; review your Gateway balance and project budget."
    case "rate limit":
      return "AI Gateway rate limit reached; wait and retry, or review account limits."
    case "model":
      return "The model was found in the public catalogue but this request was rejected; check model access and configuration."
    case "empty":
      return "The bounded synthetic probe returned no visible text. This does not prove the model is unavailable; review its reasoning/output limits or try another model."
    case "timeout":
      return "The AI Gateway request timed out; check connectivity and retry."
    case "network":
      return "The AI Gateway request failed; check network connectivity and Gateway status, then retry."
  }
}
