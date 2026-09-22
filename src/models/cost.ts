/**
 * Per-model USD pricing and real-usage-based cost computation.
 *
 * The Vercel AI Gateway does NOT return a per-call cost in `generateText`'s
 * `providerMetadata` or `usage.raw` — cost is only available after the fact,
 * via a separate REST spend-report / generation-info lookup keyed by a
 * generation id (see `@ai-sdk/gateway`'s `GatewaySpendReportRow` /
 * `GatewayGenerationInfo`). That is an async, network-bound, id-based query —
 * not something the synchronous engine call sites here can cheaply join in
 * per invocation. So cost is computed locally from real token counts (never
 * `estimateTokens`, unless the SDK genuinely returns no usage) against a
 * price map, and every row is stamped `cost_source: "estimate"`. The gateway
 * DOES hand back a per-call `generationId` inline for free (see
 * `AgentRunUsage.generationId`), which is threaded through here and stored
 * so the `cost reconcile` command (src/engines/cost-reconcile.ts) can later
 * look each one up via `getGenerationInfo` and overwrite `cost_usd` with the
 * gateway's authoritative `totalCost`, flipping `cost_source` to "gateway" —
 * additive, and never touching this per-call estimate path.
 *
 * Per the model-registry convention (see the project instructions), model IDs
 * never appear as literals in `src/**` — the price table lives in
 * `config/model-prices.default.json`, mirroring `config/models.default.json`.
 */

import { readFileSync } from "node:fs"

import { z } from "zod"

import type { SchoolIndex } from "../store/db.js"

/** Real (or best-available) token usage for a single model call. */
export type TokenUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens?: number
  readonly costUsd: number
}

/** USD price per 1,000,000 tokens. `cachedInput` defaults to `input` when unset. */
export type ModelPrice = {
  readonly input: number
  readonly output: number
  readonly cachedInput?: number | undefined
}

const modelPriceSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cachedInput: z.number().nonnegative().optional(),
})

const modelPricesFileSchema = z.strictObject({
  prices: z.record(z.string(), modelPriceSchema),
})

/**
 * `config/model-prices.default.json` records the latest observed AI Gateway
 * rates for the configured models. Refresh it whenever model routing changes;
 * an unmapped model computes to $0 (see `computeCostUsd`) rather than
 * throwing, so a new model never blocks a run — it just under-reports cost
 * until priced.
 */
function loadDefaultPrices(): Readonly<Record<string, ModelPrice>> {
  const defaultsUrl = new URL("../../config/model-prices.default.json", import.meta.url)
  const parsed = modelPricesFileSchema.parse(JSON.parse(readFileSync(defaultsUrl, "utf8")))
  return parsed.prices
}

export const modelPrices: Readonly<Record<string, ModelPrice>> = loadDefaultPrices()

export type ComputeCostInput = {
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens?: number
}

/**
 * Compute USD cost from real token counts against `modelPrices`. An unknown
 * model returns 0 rather than throwing — pricing gaps must never block a run.
 * When a gateway-reported cost is available at the call site, prefer that and
 * skip this function entirely (see the module doc above).
 */
export function computeCostUsd(input: ComputeCostInput): number {
  const price = modelPrices[input.model]
  if (price === undefined) {
    return 0
  }
  const cachedInputTokens = input.cachedInputTokens ?? 0
  const uncachedInputTokens = Math.max(0, input.inputTokens - cachedInputTokens)
  const cachedInputPrice = price.cachedInput ?? price.input
  const cost =
    (uncachedInputTokens * price.input) / 1_000_000 +
    (cachedInputTokens * cachedInputPrice) / 1_000_000 +
    (input.outputTokens * price.output) / 1_000_000
  return cost
}

/** The subset of a model call's real usage `recordModelUsage` needs. */
export type RecordedUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens?: number | null | undefined
  /** The AI Gateway's per-call generation id, if the SDK result carried one. */
  readonly generationId?: string | null | undefined
}

export type RecordModelUsageInput = {
  readonly index: SchoolIndex
  readonly model: string
  readonly functionName: string
  readonly runId: string
  readonly recordedAt: string
  /** Real usage from the SDK. Null/undefined only when the SDK reported none at all. */
  readonly usage: RecordedUsage | null | undefined
  /** Used only when `usage` (or its input/output leg) is null/undefined. */
  readonly fallbackInputTokens?: number
  readonly fallbackOutputTokens?: number
}

/**
 * The one place every call site logs a `token_usage` row: computes cost from
 * real token counts (falling back to `estimateTokens`-derived counts only
 * when the SDK reported no usage at all) and upserts it. Extracted so
 * prep.ts / assignment.ts / retrieve-triage.ts stop repeating the
 * usage-then-cost-then-upsert shape (see the Standards-review finding).
 */
export function recordModelUsage(input: RecordModelUsageInput): void {
  const inputTokens = input.usage?.inputTokens ?? input.fallbackInputTokens ?? 0
  const outputTokens = input.usage?.outputTokens ?? input.fallbackOutputTokens ?? 0
  const cachedInputTokens = input.usage?.cachedInputTokens ?? 0
  input.index.upsertTokenUsage({
    syncRunCanvasId: input.runId,
    model: input.model,
    functionName: input.functionName,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    recordedAt: input.recordedAt,
    costUsd: computeCostUsd({
      model: input.model,
      inputTokens,
      outputTokens,
      ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    }),
    generationId: input.usage?.generationId ?? null,
    // Every normal write here is the local price-table estimate; only
    // `cost reconcile` ever flips a row to "gateway".
    costSource: "estimate",
  })
}

/** Start of the calendar month containing `now`, as an ISO timestamp (UTC). */
export function startOfMonthIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

export class SpendCapExceededError extends Error {
  readonly name = "SpendCapExceededError"

  constructor(
    readonly capUsd: number,
    readonly monthToDateUsd: number,
  ) {
    super(
      `Monthly spend cap of $${capUsd.toFixed(2)} reached (month-to-date spend: ` +
        `$${monthToDateUsd.toFixed(2)}). No model call was made — raise cost.maxMonthlySpendUSD ` +
        "or wait for next month to proceed.",
    )
  }
}

export type AssertUnderSpendCapInput = {
  readonly index: SchoolIndex
  /** `config.cost.maxMonthlySpendUSD`; `null` disables the cap entirely (warn-only). */
  readonly cap: number | null
  readonly now: Date
}

/**
 * The spend-cap preflight: throws BEFORE any model call when month-to-date
 * spend already meets or exceeds the cap. Must run first in every
 * model-calling engine entry point (`generatePrepBrief`, `draftAssignment`,
 * `reviseAssignment`) — ahead of `assembleCourseContext`, which can itself
 * invoke the summary model.
 */
export function assertUnderSpendCap(input: AssertUnderSpendCapInput): void {
  if (input.cap === null) {
    return
  }
  const monthToDateUsd = input.index.costSummary({
    since: startOfMonthIso(input.now),
  }).totalCostUsd
  if (monthToDateUsd >= input.cap) {
    throw new SpendCapExceededError(input.cap, monthToDateUsd)
  }
}
