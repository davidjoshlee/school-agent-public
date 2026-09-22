import { describe, expect, it } from "vitest"

import { runCalculation } from "../../src/agents/calculate-tool.js"

describe("runCalculation", () => {
  it("evaluates arithmetic and JSON-serializes the completion value", () => {
    // Given/When: a plain arithmetic expression.
    const outcome = runCalculation({ label: "gross margin", code: "(120 - 72) / 120" })

    // Then: the result is the JSON-serialized numeric value, no error.
    expect(outcome.label).toBe("gross margin")
    expect(outcome.result).toBe(String((120 - 72) / 120))
    expect(outcome.error).toBeUndefined()
  })

  it("returns the value an IIFE returns", () => {
    // Given/When: code structured as an immediately-invoked function expression.
    const outcome = runCalculation({
      label: "npv",
      code: "(function () { const rate = 0.1; const cf = [100, 100]; return cf.reduce((sum, c, i) => sum + c / (1 + rate) ** (i + 1), 0); })()",
    })

    // Then: the IIFE's return value is the reported result.
    const expected = [100, 100].reduce((sum, c, i) => sum + c / (1 + 0.1) ** (i + 1), 0)
    expect(outcome.result).toBe(JSON.stringify(expected))
  })

  it("captures console.log output separately from the result", () => {
    // Given/When: code that logs intermediate values before its final expression.
    const outcome = runCalculation({ label: "steps", code: "console.log('step', 1); 2 + 2" })

    // Then: logs and result are both captured.
    expect(outcome.logs).toEqual([`${JSON.stringify("step")} 1`])
    expect(outcome.result).toBe("4")
  })

  it("returns the literal string 'undefined' for code with no trailing expression value", () => {
    // Given/When: a statement with no completion value.
    const outcome = runCalculation({ label: "noop", code: "const x = 1;" })

    // Then: result is the literal string, not a thrown error.
    expect(outcome.result).toBe("undefined")
    expect(outcome.error).toBeUndefined()
  })

  it("returns require, process, and fetch references as a captured error, never throwing", () => {
    // Given/When/Then: each Node-only global is absent from the fresh vm context.
    for (const code of [
      "require('node:fs')",
      "process.exit(0)",
      "fetch('https://example.invalid')",
    ]) {
      const outcome = runCalculation({ label: "escape-attempt", code })
      expect(outcome.result).toBeNull()
      expect(outcome.error).toBe("Calculation failed or timed out.")
    }
  })

  it("times out a runaway synchronous loop instead of hanging", () => {
    // Given/When: an infinite loop with no yield point.
    const outcome = runCalculation({ label: "runaway", code: "while (true) {}" })

    // Then: execution is aborted and the timeout is reported as data.
    expect(outcome.result).toBeNull()
    expect(outcome.error).toMatch(/time/i)
  }, 10_000)

  it("caps the size of the returned result and log output", () => {
    // Given/When: code that produces a very large string.
    const outcome = runCalculation({
      label: "huge",
      code: "'x'.repeat(1_000_000)",
    })

    // Then: the result is capped, not the full million characters.
    expect(outcome.result?.length).toBeLessThan(10_000)
    expect(outcome.result).toContain("truncated")
  })

  it("never throws across its own boundary on malformed code", () => {
    // Given/When: code with a syntax error.
    const outcome = runCalculation({ label: "broken", code: "this is not ) valid js" })

    // Then: the error is data, not an exception.
    expect(outcome.result).toBeNull()
    expect(typeof outcome.error).toBe("string")
  })

  it("blocks Function-constructor escapes through a realm intrinsic", () => {
    const outcome = runCalculation({
      label: "constructor escape",
      code: "Object.constructor('return process')()",
    })

    expect(outcome.result).toBeNull()
    expect(outcome.error).toBe("Calculation failed or timed out.")
  })

  it("uses captured realm serialization after user JSON tampering", () => {
    const outcome = runCalculation({
      label: "tampered serializer",
      code: "JSON.stringify = () => 'wrong'; ({ answer: 4 })",
    })

    expect(outcome.result).toBe('{"answer":4}')
  })

  it("does not invoke a calculation-installed setter while storing its result", () => {
    const outcome = runCalculation({
      label: "host setter",
      code: "Object.defineProperty(globalThis, '__schoolCalculateValue', { set() { throw new Error('setter called'); }, configurable: true }); 1",
    })

    expect(outcome.result).toBe("1")
    expect(outcome.error).toBeUndefined()
  })

  it("keeps prototype changes inside one calculation realm", () => {
    runCalculation({
      label: "poison prototype",
      code: "Object.prototype.friendSetupPolluted = true; ({})",
    })
    const clean = runCalculation({ label: "fresh realm", code: "({}).friendSetupPolluted" })

    expect(clean.result).toBe("undefined")
    expect(Object.prototype).not.toHaveProperty("friendSetupPolluted")
  })

  it("times out hostile result serialization inside the VM", () => {
    const outcome = runCalculation({
      label: "hostile toJSON",
      code: "({ toJSON() { while (true) {} } })",
    })

    expect(outcome.result).toBeNull()
    expect(outcome.error).toBe("Calculation failed or timed out.")
  }, 10_000)
})
