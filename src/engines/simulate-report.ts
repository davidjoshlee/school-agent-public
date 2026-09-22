import { z } from "zod"

// Canonical schema for a simulation run's report.json, shared by compare.ts
// and gate-m1.ts so the two engines can never silently drift on what a valid
// report looks like.
const simulationArtifactSchema = z.strictObject({
  path: z.string().min(1),
  sources: z.array(z.string()),
})
const completedSimulationWeekSchema = z.strictObject({
  asOf: z.string().min(1),
  status: z.literal("completed"),
  brief: simulationArtifactSchema,
  drafts: z.array(simulationArtifactSchema),
})
// Per-signal breakdown of the as-of visibility rule (see simulate-visibility.ts).
// Optional so a report.json written before this field existed still parses.
const visibilitySchema = z.strictObject({
  bySignal: z.strictObject({
    unlock_at: z.number().int().nonnegative(),
    posted_at: z.number().int().nonnegative(),
    module_release: z.number().int().nonnegative(),
    due_at: z.number().int().nonnegative(),
    created_at: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
})

export const simulationReportSchema = z.strictObject({
  runId: z.string().min(1),
  unknownVisibility: z.number().int().nonnegative(),
  leakageCount: z.number().int().nonnegative(),
  weeks: z.array(
    z.discriminatedUnion("status", [
      z.strictObject({ asOf: z.string().min(1), status: z.literal("empty") }),
      completedSimulationWeekSchema,
    ]),
  ),
  visibility: visibilitySchema.optional(),
})

export type SimulationReport = z.infer<typeof simulationReportSchema>
export type CompletedSimulationWeek = z.infer<typeof completedSimulationWeekSchema>
export type SimulationArtifact = z.infer<typeof simulationArtifactSchema>
