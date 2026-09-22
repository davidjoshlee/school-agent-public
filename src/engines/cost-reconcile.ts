/**
 * `cost reconcile`: validate the local price-table cost estimate against the
 * AI Gateway's authoritative per-generation cost. Every `token_usage` row
 * that carries a captured `generation_id` (see `AgentRunUsage.generationId`)
 * is eligible; for each, `getGenerationInfo({ id })` is looked up and the
 * row's `cost_usd` is overwritten with the gateway's `totalCost`, flipping
 * `cost_source` to "gateway".
 *
 * This is deliberately additive and best-effort: the gateway lookup is an
 * authenticated network call keyed by an id that can be too old, rate
 * limited, or simply unreachable. A single failed lookup must never abort
 * the whole command — it is counted as skipped and the run continues.
 */

import type { SchoolIndex } from "../store/db.js"
import type { ReconciliationCandidate } from "../store/db-types.js"

/** The shape of `@ai-sdk/gateway`'s `GatewayProvider.getGenerationInfo`, narrowed to what reconcile needs. */
export type GenerationInfoLookup = (params: {
  readonly id: string
}) => Promise<{ readonly totalCost: number }>

export type ReconcileSkip = {
  readonly generationId: string
  readonly reason: string
}

export type ReconcileSummary = {
  readonly candidateCount: number
  readonly reconciled: number
  readonly skipped: readonly ReconcileSkip[]
}

/**
 * Reconcile every `token_usage` row in `[since, now]` that carries a gateway
 * generation id. Never throws on a per-row lookup failure — see module doc.
 */
export async function reconcileTokenUsage(input: {
  readonly index: SchoolIndex
  readonly since: string
  readonly lookup: GenerationInfoLookup
}): Promise<ReconcileSummary> {
  const candidates = input.index.tokenUsageForReconciliation(input.since)
  let reconciled = 0
  const skipped: ReconcileSkip[] = []
  for (const candidate of candidates) {
    // Sequential by design: rate-limit-friendly, and the gateway lookup count
    // per run is small (one per unreconciled row in the window).
    const outcome = await reconcileOne(candidate, input.lookup)
    if (outcome.ok) {
      input.index.applyReconciledCost(candidate, outcome.totalCost)
      reconciled += 1
    } else {
      skipped.push({ generationId: candidate.generationId, reason: outcome.reason })
    }
  }
  return { candidateCount: candidates.length, reconciled, skipped }
}

async function reconcileOne(
  candidate: ReconciliationCandidate,
  lookup: GenerationInfoLookup,
): Promise<
  | { readonly ok: true; readonly totalCost: number }
  | { readonly ok: false; readonly reason: string }
> {
  try {
    const info = await lookup({ id: candidate.generationId })
    return { ok: true, totalCost: info.totalCost }
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Whether any AI Gateway credential is configured in this environment. The
 * gateway resolves an API key from `AI_GATEWAY_API_KEY` by default, or a
 * Vercel OIDC token from `VERCEL_OIDC_TOKEN` when running under Vercel's
 * runtime — `reconcile` should refuse cleanly up front rather than let an
 * unauthenticated `getGenerationInfo` call surface as a confusing failure
 * per row.
 */
export function hasGatewayCredentials(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return (
    (environment["AI_GATEWAY_API_KEY"] ?? "") !== "" ||
    (environment["VERCEL_OIDC_TOKEN"] ?? "") !== ""
  )
}

export class GatewayNotConfiguredError extends Error {
  readonly name = "GatewayNotConfiguredError"

  constructor() {
    super(
      "No AI Gateway credentials configured (set AI_GATEWAY_API_KEY, or run under Vercel OIDC) " +
        "— `cost reconcile` needs the gateway's getGenerationInfo lookup and cannot run.",
    )
  }
}
