/**
 * Assignment self-review: after a draft (or revision) is produced and before
 * it is written for approval, a second model pass re-reads the draft against
 * the assignment's actual questions and the supplied source material, then
 * appends a `## Correctness check` note flagging what is verified vs
 * uncertain. Numeric verification is evidence-based, not another model
 * guess: every `calculate` tool call the draft agent actually made is
 * extracted from the run's durable message history (see
 * `agents/run-tools.ts`) and handed to the reviewer as a `## Computation
 * log`; the reviewer's job is to match draft numbers against that log, not
 * to recompute them itself.
 */

import type { ComputationLogEntry } from "../agents/run-tools.js"
import type { AgentRunner, AgentRunResult } from "../agents/runner.js"

/** The H2 heading marking the appended self-review note on every draft. */
export const correctnessCheckHeading = "## Correctness check"

const unverifiedNote =
  "- **Needs verification**: the automated correctness self-review did not return a result. Treat every part of this draft as unverified and check it against the assignment questions and source data yourself."

export type SelfReviewInput = {
  readonly courseCode: string
  readonly assignmentTitle: string
  readonly assignmentUrl: string
  readonly draft: string
  readonly context: string
  readonly computations: readonly ComputationLogEntry[]
}

/**
 * Append the self-review note under `## Correctness check`, replacing any
 * correctness-check section the draft already carries (e.g. one a revision
 * held over from the previous version) so exactly one fresh note remains.
 */
export function withCorrectnessCheck(draft: string, note: string): string {
  return `${withoutCorrectnessCheck(draft)}\n\n${correctnessCheckHeading}\n\n${note.trim()}`
}

export type SelfReviewResult = {
  readonly note: string
  /** Real token usage for the review call, null when it failed or the SDK reported none. */
  readonly usage: AgentRunResult["usage"]
}

/**
 * Run the correctness self-review as a second, independent model call. A
 * review failure never blocks the draft: the note degrades to an explicit
 * "unverified" flag so the approval gate still sees an honest artifact.
 */
export async function selfReviewDraft(
  runner: AgentRunner,
  input: SelfReviewInput,
): Promise<SelfReviewResult> {
  try {
    const result = await runner.run(reviewPrompt(input))
    const note = result.text?.trim()
    return {
      note: note === undefined || note.length === 0 ? unverifiedNote : note,
      usage: result.usage,
    }
  } catch {
    return { note: unverifiedNote, usage: null }
  }
}

function reviewPrompt(input: SelfReviewInput): string {
  return [
    `You are the correctness reviewer for a completed ${input.courseCode} assignment, "${input.assignmentTitle}" (${input.assignmentUrl}), checking the draft before the student sees it.`,
    "Re-read the draft below against the assignment's actual questions and the supplied source material and data. Verify that every question and requirement the assignment asks is answered, that the answers are internally consistent, and that every number, quote, and claim matches the supplied sources.",
    "Treat any quantitative value (a figure, exhibit value, dataset number, or table cell) that is NOT grounded in the supplied Materials as a defect, even if it looks plausible — flag it as a likely fabrication rather than crediting it as verified. Separately confirm that every answer the draft could not ground in the Materials is marked `PENDING — requires <source>` (not a guessed value) and that any such gaps are named in a `## Missing required sources` section; note it as a defect if a gap was left unmarked or a value was fabricated in its place.",
    computationInstructions(input.computations),
    "Flag explicitly anything you cannot verify from the supplied material — for example a claim no supplied source supports.",
    "Return ONLY Markdown bullets grouped under the bold labels **Verified** and **Needs verification**. Do not rewrite the draft, do not add any heading, and do not call any tool.",
    `## Draft under review\n${input.draft}`,
    computationLogSection(input.computations),
    input.context,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n")
}

// The reviewer verifies numbers against ACTUAL executed calculations, never
// by redoing the arithmetic itself — a second model guess is not
// verification. Every non-verbatim-source number must trace to an entry here.
function computationInstructions(computations: readonly ComputationLogEntry[]): string {
  const base =
    "Every number in the draft that is NOT a source figure quoted verbatim from the Materials " +
    "must appear as a `result` in the `## Computation log` below. Do not recompute or re-derive " +
    "any value yourself — verification means matching the draft's numbers against that log, not " +
    "checking the arithmetic. Flag any derived number with no matching computation as " +
    "`**Unverified derived value**`, and flag any computation whose log entry carries an `error` " +
    "as a defect. If the draft's own `## Computations` section lists a result that does not match " +
    "the log, flag that mismatch too."
  return computations.length === 0
    ? `${base} The computation log is empty: if the draft states ANY derived number, every one of them is an unverified derived value.`
    : base
}

function computationLogSection(computations: readonly ComputationLogEntry[]): string {
  if (computations.length === 0) {
    return ""
  }
  const lines = computations.map((entry) => {
    const outcome = entry.error === undefined ? `result: ${entry.result}` : `error: ${entry.error}`
    return `- **${entry.label}** — \`${entry.code}\` — ${outcome}`
  })
  return `## Computation log\n${lines.join("\n")}`
}

function withoutCorrectnessCheck(draft: string): string {
  const match = /^## Correctness check\s*$/m.exec(draft)
  if (match === null) {
    return draft.trim()
  }
  const rest = draft.slice(match.index + match[0].length)
  const next = /^## /m.exec(rest)
  const end = next === null ? draft.length : match.index + match[0].length + next.index
  return `${draft.slice(0, match.index)}${draft.slice(end)}`.replace(/\n{3,}/g, "\n\n").trim()
}
