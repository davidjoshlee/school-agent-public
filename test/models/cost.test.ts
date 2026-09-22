import { describe, expect, it } from "vitest"

import {
  assertUnderSpendCap,
  computeCostUsd,
  modelPrices,
  recordModelUsage,
  SpendCapExceededError,
} from "../../src/models/cost.js"
import { createSchoolIndex } from "../../src/store/db.js"

describe("computeCostUsd", () => {
  it("computes dollars from the configured placeholder price for a known model", () => {
    // Given: a model priced in config/model-prices.default.json.
    const [model, price] = Object.entries(modelPrices)[0] ?? []
    if (model === undefined || price === undefined) {
      throw new Error("expected at least one priced model in the fixture config")
    }

    // When: cost is computed for 1,000,000 input and 1,000,000 output tokens.
    const cost = computeCostUsd({ model, inputTokens: 1_000_000, outputTokens: 1_000_000 })

    // Then: it matches the price table exactly (input + output per-1M rates).
    expect(cost).toBeCloseTo(price.input + price.output, 10)
  })

  it("discounts cached input tokens at the cached rate", () => {
    const [model, price] = Object.entries(modelPrices)[0] ?? []
    if (model === undefined || price === undefined) {
      throw new Error("expected at least one priced model in the fixture config")
    }
    const cachedInputPrice = price.cachedInput ?? price.input

    const cost = computeCostUsd({
      model,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    })

    expect(cost).toBeCloseTo(cachedInputPrice, 10)
  })

  it("returns 0 for an unpriced model without throwing", () => {
    // Given/When: a model id absent from the price table.
    const cost = computeCostUsd({
      model: "unknown/not-priced-model",
      inputTokens: 1_000,
      outputTokens: 1_000,
    })

    // Then: cost degrades to 0 rather than throwing.
    expect(cost).toBe(0)
  })
})

describe("recordModelUsage", () => {
  it("uses real usage over the fallback, and persists cached tokens and the recorded timestamp", () => {
    // Given: an empty index and a call with real usage present.
    const index = createSchoolIndex({ path: ":memory:" })
    const [model] = Object.keys(modelPrices)
    if (model === undefined) {
      throw new Error("expected at least one priced model in the fixture config")
    }

    // When: usage is recorded with real (non-null) SDK usage.
    recordModelUsage({
      index,
      model,
      functionName: "prepBrief",
      runId: "run-1",
      recordedAt: "2026-09-05T00:00:00.000Z",
      usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 10 },
      fallbackInputTokens: 9999,
      fallbackOutputTokens: 9999,
    })

    // Then: the real usage — not the fallback — is what gets stored.
    const logged = index.tokenUsageForFunction("prepBrief")
    expect(logged).toMatchObject({
      model,
      functionName: "prepBrief",
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 10,
      recordedAt: "2026-09-05T00:00:00.000Z",
    })
    expect(logged?.costUsd).toBeGreaterThan(0)
    index.close()
  })

  it("persists a captured gateway generationId onto the token_usage row, stamped as an estimate", () => {
    // Given: an empty index and usage that carries a gateway generationId.
    const index = createSchoolIndex({ path: ":memory:" })
    const [model] = Object.keys(modelPrices)
    if (model === undefined) {
      throw new Error("expected at least one priced model in the fixture config")
    }

    // When: usage is recorded with a generationId present.
    recordModelUsage({
      index,
      model,
      functionName: "prepBrief",
      runId: "run-gen-id",
      recordedAt: "2026-09-05T00:00:00.000Z",
      usage: { inputTokens: 100, outputTokens: 40, generationId: "gen_xyz789" },
    })

    // Then: the generation id and default "estimate" cost_source both land on the row.
    const logged = index.tokenUsageForFunction("prepBrief")
    expect(logged).toMatchObject({ generationId: "gen_xyz789", costSource: "estimate" })
    index.close()
  })

  it("stores generationId as null when usage reports none", () => {
    const index = createSchoolIndex({ path: ":memory:" })
    const [model] = Object.keys(modelPrices)
    if (model === undefined) {
      throw new Error("expected at least one priced model in the fixture config")
    }

    recordModelUsage({
      index,
      model,
      functionName: "prepBrief",
      runId: "run-no-gen-id",
      recordedAt: "2026-09-05T00:00:00.000Z",
      usage: { inputTokens: 100, outputTokens: 40 },
    })

    const logged = index.tokenUsageForFunction("prepBrief")
    expect(logged).toMatchObject({ generationId: null, costSource: "estimate" })
    index.close()
  })

  it("falls back to the supplied estimate only when the SDK reported no usage at all", () => {
    // Given: an empty index and a call whose usage is null (SDK reported none).
    const index = createSchoolIndex({ path: ":memory:" })

    // When: usage is recorded with usage: null.
    recordModelUsage({
      index,
      model: "unpriced/model",
      functionName: "assignmentDraft",
      runId: "run-2",
      recordedAt: "2026-09-05T00:00:00.000Z",
      usage: null,
      fallbackInputTokens: 50,
      fallbackOutputTokens: 20,
    })

    // Then: the fallback counts are stored, and cost degrades to 0 for the unpriced model.
    expect(index.tokenUsageForFunction("assignmentDraft")).toMatchObject({
      inputTokens: 50,
      outputTokens: 20,
      cachedInputTokens: 0,
      costUsd: 0,
    })
    index.close()
  })
})

describe("assertUnderSpendCap", () => {
  it("does nothing when the cap is null (warn-only mode)", () => {
    const index = createSchoolIndex({ path: ":memory:" })
    expect(() => assertUnderSpendCap({ index, cap: null, now: new Date() })).not.toThrow()
    index.close()
  })

  it("does nothing when month-to-date spend is under the cap", () => {
    const index = createSchoolIndex({ path: ":memory:" })
    const now = new Date("2026-09-15T00:00:00.000Z")
    index.upsertTokenUsage({
      syncRunCanvasId: "run-1",
      model: "mock/model",
      functionName: "prepBrief",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      recordedAt: now.toISOString(),
      costUsd: 1,
    })

    expect(() => assertUnderSpendCap({ index, cap: 10, now })).not.toThrow()
    index.close()
  })

  it("throws SpendCapExceededError when month-to-date spend meets or exceeds the cap", () => {
    const index = createSchoolIndex({ path: ":memory:" })
    const now = new Date("2026-09-15T00:00:00.000Z")
    index.upsertTokenUsage({
      syncRunCanvasId: "run-1",
      model: "mock/model",
      functionName: "prepBrief",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      recordedAt: now.toISOString(),
      costUsd: 10,
    })

    expect(() => assertUnderSpendCap({ index, cap: 10, now })).toThrow(SpendCapExceededError)
    index.close()
  })

  it("excludes spend recorded before the current calendar month", () => {
    const index = createSchoolIndex({ path: ":memory:" })
    const now = new Date("2026-09-15T00:00:00.000Z")
    index.upsertTokenUsage({
      syncRunCanvasId: "run-1",
      model: "mock/model",
      functionName: "prepBrief",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      recordedAt: "2026-08-31T23:59:59.000Z",
      costUsd: 100,
    })

    expect(() => assertUnderSpendCap({ index, cap: 10, now })).not.toThrow()
    index.close()
  })
})
