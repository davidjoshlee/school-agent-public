/**
 * Shared vocabulary for the M2 `dogfood` command: a `DogfoodFlow` is one of
 * the 10 core-flow checks (sync, timeline, guidance, prep, draft, co-edit,
 * approve, token-renewal alert, gaps re-check, cost report). `runDogfood`
 * (dogfood.ts) is the injectable orchestration core; `dogfood-flows.ts` /
 * `dogfood-flows-review.ts` build the real flows against the real engines.
 */

/** What a flow reports on success: a short evidence string (a vault-relative
 * path, or a compact summary) plus optional free-text note. `human` is set
 * only by the two flows (prep, draft) that produce a subjective artifact —
 * always blank ("") at write time, left for the human M2 ritual to fill in.
 */
export type DogfoodFlowOutcome = {
  readonly evidence: string
  readonly note?: string | undefined
  readonly human?: string | undefined
}

export type DogfoodFlow = {
  readonly name: string
  /** "auto": a pass verdict is final. "human": a completed run is recorded
   * "pending-human" — it still needs a person to confirm quality. None of
   * the 10 concrete flows currently use "human"; the type exists so a future
   * flow can opt in without changing the runner. */
  readonly kind: "auto" | "human"
  run(): Promise<DogfoodFlowOutcome>
}

export type DogfoodFlowStatus = "pass" | "fail" | "pending-human" | "skipped"

/** A flow's `run()` throws this to signal "this session has nothing to check
 * here" (e.g. the draft/co-edit/approve flows on a prep-only session with no
 * draftable assignment) — recorded as status "skipped", never "fail" and
 * never a bogus "pass". */
export class DogfoodFlowSkip extends Error {
  readonly name = "DogfoodFlowSkip"
}

/** One resolved teaching session for `dogfood --sessions <n>` (see
 * dogfood-sweep-resolve.ts): a module whose title matches "Session <N>".
 * `assignmentId` is null for a prep-only session (no assignment linked from
 * that module). */
export type DogfoodSweepSession = {
  readonly sessionNumber: number
  readonly title: string
  readonly weekDate: string
  readonly assignmentId: string | null
}

export type DogfoodFlowResult = {
  readonly name: string
  readonly kind: "auto" | "human"
  readonly status: DogfoodFlowStatus
  readonly durationMs: number
  readonly evidence: string
  readonly note?: string | undefined
  readonly error?: string | undefined
  readonly human?: string | undefined
}

export type DogfoodTarget = {
  readonly course: string
  readonly week: string
  readonly assignment: string
}

/** A course the sweep already synced once, so each session's sync flow can
 * verify against it instead of re-downloading the whole course every session
 * (the dominant cost of a run). */
export type PreSyncedCourse = {
  readonly courseCode: string
  readonly courseId: string
  readonly courseUrl: string
  readonly gaps: number
  readonly permissionGaps: number
}

export type DogfoodResults = DogfoodTarget & {
  readonly startedAt: string
  readonly flows: readonly DogfoodFlowResult[]
}
