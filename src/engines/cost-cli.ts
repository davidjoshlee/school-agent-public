import { createGateway } from "ai"
import type { Command } from "commander"
import { z } from "zod"

import { loadConfig } from "../config/index.js"
import { startOfMonthIso } from "../models/cost.js"
import { createSchoolIndex, type SchoolIndex } from "../store/db.js"
import type { CostSummary } from "../store/db-types.js"
import {
  GatewayNotConfiguredError,
  hasGatewayCredentials,
  type ReconcileSummary,
  reconcileTokenUsage,
} from "./cost-reconcile.js"

type RootOptions = { readonly config: string }

const costOptionsSchema = z.strictObject({
  weeks: z.coerce.number().int().positive().optional(),
})

export function registerCostCommand(program: Command): void {
  const cost = program
    .command("cost")
    .description("Show model-usage token counts and cost, grouped by function and model")
    .option("--weeks <number>", "look back N weeks instead of the current calendar month")
  cost.action(() => {
    const root = program.opts<RootOptions>()
    const options = costOptionsSchema.parse(cost.opts())
    const configuration = loadConfig(root.config)
    const index = createSchoolIndex({ path: configuration.index.path })
    try {
      const now = new Date()
      const since =
        options.weeks === undefined ? startOfMonthIso(now) : weeksAgoIso(now, options.weeks)
      const summary = index.costSummary({ since })
      console.log(
        renderCostReport(summary, {
          cap: configuration.cost.maxMonthlySpendUSD,
          monthToDateCostUsd: monthToDateCostUsd(index, now),
        }),
      )
    } finally {
      index.close()
    }
  })

  const reconcile = cost
    .command("reconcile")
    .description(
      "Validate estimated cost against the AI Gateway's authoritative per-generation cost",
    )
    .option("--weeks <number>", "look back N weeks instead of the current calendar month")
  reconcile.action(async () => {
    const root = program.opts<RootOptions>()
    const options = costOptionsSchema.parse(reconcile.opts())
    // No gateway credentials at all: refuse cleanly up front (a thrown error,
    // caught by runCli into a non-zero exit) rather than let an
    // unauthenticated getGenerationInfo call fail confusingly per row.
    if (!hasGatewayCredentials()) {
      throw new GatewayNotConfiguredError()
    }
    const configuration = loadConfig(root.config)
    const index = createSchoolIndex({ path: configuration.index.path })
    try {
      const now = new Date()
      const since =
        options.weeks === undefined ? startOfMonthIso(now) : weeksAgoIso(now, options.weeks)
      const gateway = createGateway()
      const summary = await reconcileTokenUsage({
        index,
        since,
        lookup: (params) => gateway.getGenerationInfo(params),
      })
      console.log(renderReconcileReport(summary))
    } finally {
      index.close()
    }
  })
}

function weeksAgoIso(now: Date, weeks: number): string {
  return new Date(now.getTime() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString()
}

function monthToDateCostUsd(index: SchoolIndex, now: Date): number {
  return index.costSummary({ since: startOfMonthIso(now) }).totalCostUsd
}

export function renderCostReport(
  summary: CostSummary,
  options: { readonly cap: number | null; readonly monthToDateCostUsd: number },
): string {
  const lines = [
    ["function", "model", "input", "output", "cached", "uncached", "cost_usd", "source"].join("\t"),
  ]
  for (const group of summary.groups) {
    lines.push(
      [
        group.functionName,
        group.model,
        group.inputTokens,
        group.outputTokens,
        group.cachedInputTokens,
        Math.max(0, group.inputTokens - group.cachedInputTokens),
        group.costUsd.toFixed(4),
        group.costSource,
      ].join("\t"),
    )
  }
  // TOTAL sums across every source, so it carries no single cost_source.
  lines.push(
    [
      "TOTAL",
      "",
      summary.totalInputTokens,
      summary.totalOutputTokens,
      summary.totalCachedInputTokens,
      Math.max(0, summary.totalInputTokens - summary.totalCachedInputTokens),
      summary.totalCostUsd.toFixed(4),
      "",
    ].join("\t"),
  )
  if (options.cap !== null) {
    lines.push(
      `Month-to-date spend: $${options.monthToDateCostUsd.toFixed(2)} of $${options.cap.toFixed(2)} cap`,
    )
  }
  return lines.join("\n")
}

export function renderReconcileReport(summary: ReconcileSummary): string {
  const lines = [
    `Reconciled ${summary.reconciled} of ${summary.candidateCount} candidate row(s) against the AI Gateway.`,
  ]
  if (summary.skipped.length > 0) {
    lines.push(`Skipped ${summary.skipped.length}:`)
    for (const skip of summary.skipped) {
      lines.push(`  ${skip.generationId}: ${skip.reason}`)
    }
  }
  return lines.join("\n")
}
