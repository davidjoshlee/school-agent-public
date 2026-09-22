import { describe, expect, it } from "vitest"

import { simulationReportSchema } from "../src/engines/simulate-report.js"

const baseReport = {
  runId: "run-1",
  unknownVisibility: 2,
  leakageCount: 0,
  weeks: [{ asOf: "2025-01-08", status: "empty" as const }],
}

describe("simulationReportSchema", () => {
  it("parses a report carrying the visibility.bySignal breakdown", () => {
    const report = {
      ...baseReport,
      visibility: {
        bySignal: {
          unlock_at: 3,
          posted_at: 1,
          module_release: 5,
          due_at: 2,
          created_at: 0,
          unknown: 4,
        },
      },
    }
    expect(simulationReportSchema.parse(report)).toEqual(report)
  })

  it("still parses a report.json written before the visibility field existed", () => {
    expect(simulationReportSchema.parse(baseReport)).toEqual(baseReport)
  })

  it("rejects a visibility.bySignal missing one of the six signals", () => {
    expect(() =>
      simulationReportSchema.parse({
        ...baseReport,
        visibility: {
          bySignal: {
            unlock_at: 0,
            posted_at: 0,
            module_release: 0,
            due_at: 0,
            created_at: 0,
            // "unknown" omitted
          },
        },
      }),
    ).toThrow()
  })
})
