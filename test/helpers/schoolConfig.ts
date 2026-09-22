import { join } from "node:path"

import { CanvasHttpClient, type CanvasHttpClientOptions } from "../../src/canvas/http.js"
import type { SchoolConfig } from "../../src/config/index.js"

/** The canonical msw origin shared by every Canvas-backed test. */
export const canvasBaseUrl = "https://canvas.test"

/**
 * The deterministic model registry used by the Canvas-sync fixtures. Tests that
 * exercise a model-backed engine override `triage`/`generation`/`functions` via
 * {@link schoolConfig}.
 */
export const defaultSchoolModels: SchoolConfig["models"] = {
  triage: "mock/triage",
  generation: "mock/generation",
  functions: {
    extractSummary: "mock/triage",
    prepBrief: "mock/prep",
    assignmentDraft: "mock/draft",
    assignmentDiscuss: "mock/discuss",
    coverageCompare: "mock/compare",
    playbookUpdate: "mock/playbook",
  },
}

/**
 * The model registry used by fixtures that exercise a real provider-aware
 * engine (`retrieve`, `prep`) where the assertion depends on the provider that
 * serves a given function name.
 */
export const realSchoolModels: SchoolConfig["models"] = {
  triage: "openai/gpt-4.1-mini",
  generation: "anthropic/claude-3-7-sonnet",
  functions: {
    extractSummary: "openai/gpt-4.1-mini",
    prepBrief: "anthropic/claude-3-7-sonnet",
    assignmentDraft: "anthropic/claude-3-7-sonnet",
    assignmentDiscuss: "openai/gpt-4.1-mini",
    coverageCompare: "google/gemini-2.5-flash",
    playbookUpdate: "openai/gpt-4.1-mini",
  },
}

export type SchoolConfigOverrides = Readonly<{
  readonly vaultPath: string
  readonly canvas?: Partial<SchoolConfig["canvas"]>
  readonly index?: Partial<SchoolConfig["index"]>
  readonly models?: Partial<Omit<SchoolConfig["models"], "functions">> & {
    readonly functions?: Partial<SchoolConfig["models"]["functions"]>
  }
  readonly aiPolicyDefault?: SchoolConfig["aiPolicyDefault"]
  readonly courses?: Partial<SchoolConfig["courses"]>
  readonly sync?: Partial<SchoolConfig["sync"]>
  readonly assignments?: Partial<SchoolConfig["assignments"]>
  readonly cost?: Partial<SchoolConfig["cost"]>
  readonly restrictedFileHandling?: SchoolConfig["restrictedFileHandling"]
  readonly renew?: Partial<SchoolConfig["renew"]>
  readonly files?: Partial<SchoolConfig["files"]>
  readonly prep?: Partial<SchoolConfig["prep"]>
}>

/**
 * Build a complete, typed {@link SchoolConfig}. Every field is defaulted to the
 * canonical pilot fixture shape (the one `sync.test.ts::pilotConfig` used to
 * inline); callers override only the fields that matter to a given test.
 *
 * `vaultPath` is required because it anchors the vault and the default SQLite
 * index location.
 */
export function schoolConfig(overrides: SchoolConfigOverrides): SchoolConfig {
  const vaultPath = overrides.vaultPath
  return {
    canvas: { baseUrl: canvasBaseUrl, tokenEnv: "CANVAS_TOKEN", ...overrides.canvas },
    vault: { path: vaultPath, gitInit: false },
    index: { path: join(vaultPath, "school.sqlite"), ...overrides.index },
    models: {
      ...defaultSchoolModels,
      ...overrides.models,
      functions: {
        ...defaultSchoolModels.functions,
        ...overrides.models?.functions,
      },
    },
    aiPolicyDefault: overrides.aiPolicyDefault ?? "allowed",
    courses: { mode: "auto", allowlist: [], pilotCourseId: "1", ...overrides.courses },
    sync: { intervalMinutes: 60, staleAfterHours: 24, leadDays: 7, ...overrides.sync },
    assignments: { autoDraftUpcoming: false, ...overrides.assignments },
    cost: { maxMonthlySpendUSD: null, ...overrides.cost },
    restrictedFileHandling: overrides.restrictedFileHandling ?? "exclude",
    renew: { warnDaysBefore: 5, ...overrides.renew },
    files: { maxSizeMB: 100, ...overrides.files },
    prep: { granularity: "week", ...overrides.prep },
  }
}

export type CanvasClientOptions = Partial<
  Pick<CanvasHttpClientOptions, "baseUrl" | "tokenEnv" | "environment" | "sleep" | "random">
>

/**
 * Build a {@link CanvasHttpClient} pinned to the msw origin with the token the
 * test handlers expect. `reportRequestCost` is always suppressed so the suite
 * stays quiet on `x-request-cost`; pass `random`/`sleep` to control retry jitter
 * (e.g. `client({ random: () => 0 })` for the deterministic backoff test).
 */
export function client(options: CanvasClientOptions = {}): CanvasHttpClient {
  return new CanvasHttpClient({
    baseUrl: options.baseUrl ?? canvasBaseUrl,
    tokenEnv: options.tokenEnv ?? "CANVAS_TOKEN",
    environment: options.environment ?? { CANVAS_TOKEN: "fixture-token" },
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    reportRequestCost: () => undefined,
  })
}
