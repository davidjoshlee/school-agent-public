import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { runDogfood } from "../src/engines/dogfood.js"
import type { DogfoodFlow, DogfoodTarget } from "../src/engines/dogfood-types.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

const target: DogfoodTarget = { course: "17", week: "2026-09-02", assignment: "auto" }

function fakeFlow(
  name: string,
  behavior: "pass" | "fail",
  calls: string[],
  overrides: Partial<Pick<DogfoodFlow, "kind">> = {},
): DogfoodFlow {
  return {
    name,
    kind: overrides.kind ?? "auto",
    async run() {
      calls.push(name)
      if (behavior === "fail") {
        throw new Error(`${name} exploded`)
      }
      return { evidence: `${name}-evidence` }
    },
  }
}

async function paths(): Promise<{ readonly resultsPath: string; readonly summaryPath: string }> {
  const directory = await temporaryDirectory("school-agent-dogfood-")
  return {
    resultsPath: join(directory, "dogfood-results.json"),
    summaryPath: join(directory, "dogfood-summary.md"),
  }
}

describe("runDogfood", () => {
  it("runs flows in order, records pass/fail/duration, and isolates a failure from the rest", async () => {
    const calls: string[] = []
    const { resultsPath, summaryPath } = await paths()
    const flows = [
      fakeFlow("sync", "pass", calls),
      fakeFlow("timeline", "fail", calls),
      fakeFlow("guidance note", "pass", calls),
    ]

    const summary = await runDogfood({
      flows,
      target,
      resultsPath,
      summaryPath,
      log: () => {},
    })

    // Ordering: every flow ran, in order, even after a failure.
    expect(calls).toEqual(["sync", "timeline", "guidance note"])
    expect(summary.total).toBe(3)
    expect(summary.passed).toBe(2)
    expect(summary.results.flows.map((flow) => flow.status)).toEqual(["pass", "fail", "pass"])
    expect(summary.results.flows[1]?.error).toBe("timeline exploded")
    expect(summary.results.flows.every((flow) => typeof flow.durationMs === "number")).toBe(true)
  })

  it("writes a results JSON and a readable markdown summary matching the run", async () => {
    const calls: string[] = []
    const { resultsPath, summaryPath } = await paths()
    await runDogfood({
      flows: [fakeFlow("sync", "pass", calls)],
      target,
      resultsPath,
      summaryPath,
      log: () => {},
    })

    const resultsJson = JSON.parse(await readFile(resultsPath, "utf8"))
    expect(resultsJson).toMatchObject({
      course: target.course,
      week: target.week,
      assignment: target.assignment,
      flows: [{ name: "sync", status: "pass", evidence: "sync-evidence" }],
    })
    expect(typeof resultsJson.startedAt).toBe("string")

    const summaryMd = await readFile(summaryPath, "utf8")
    expect(summaryMd).toContain("# Dogfood run")
    expect(summaryMd).toContain("1/1 passed")
    expect(summaryMd).toContain("sync-evidence")
  })

  it("resumes by skipping an already-passed flow and only reruns the rest", async () => {
    const firstCalls: string[] = []
    const { resultsPath, summaryPath } = await paths()
    await runDogfood({
      flows: [fakeFlow("sync", "pass", firstCalls), fakeFlow("timeline", "fail", firstCalls)],
      target,
      resultsPath,
      summaryPath,
      log: () => {},
    })

    // When: rerun with "timeline" now fixed to pass.
    const secondCalls: string[] = []
    const summary = await runDogfood({
      flows: [fakeFlow("sync", "pass", secondCalls), fakeFlow("timeline", "pass", secondCalls)],
      target,
      resultsPath,
      summaryPath,
      log: () => {},
    })

    // Then: the already-passed "sync" flow's run() is never called again.
    expect(secondCalls).toEqual(["timeline"])
    expect(summary.passed).toBe(2)
    expect(summary.results.flows.map((flow) => flow.status)).toEqual(["pass", "pass"])
  })

  it("--fresh reruns every flow even when all previously passed", async () => {
    const firstCalls: string[] = []
    const { resultsPath, summaryPath } = await paths()
    await runDogfood({
      flows: [fakeFlow("sync", "pass", firstCalls)],
      target,
      resultsPath,
      summaryPath,
      log: () => {},
    })

    const secondCalls: string[] = []
    await runDogfood({
      flows: [fakeFlow("sync", "pass", secondCalls)],
      target,
      resultsPath,
      summaryPath,
      fresh: true,
      log: () => {},
    })

    expect(secondCalls).toEqual(["sync"])
  })

  it("does not resume across a different target (course/week/assignment)", async () => {
    const firstCalls: string[] = []
    const { resultsPath, summaryPath } = await paths()
    await runDogfood({
      flows: [fakeFlow("sync", "pass", firstCalls)],
      target,
      resultsPath,
      summaryPath,
      log: () => {},
    })

    const otherTarget: DogfoodTarget = { ...target, week: "2026-09-09" }
    const secondCalls: string[] = []
    await runDogfood({
      flows: [fakeFlow("sync", "pass", secondCalls)],
      target: otherTarget,
      resultsPath,
      summaryPath,
      log: () => {},
    })

    expect(secondCalls).toEqual(["sync"])
  })

  it("marks a completed 'human' kind flow pending-human rather than pass", async () => {
    const calls: string[] = []
    const { resultsPath, summaryPath } = await paths()
    const summary = await runDogfood({
      flows: [fakeFlow("eyeball", "pass", calls, { kind: "human" })],
      target,
      resultsPath,
      summaryPath,
      log: () => {},
    })

    expect(summary.results.flows[0]?.status).toBe("pending-human")
    expect(summary.passed).toBe(0)
  })
})
