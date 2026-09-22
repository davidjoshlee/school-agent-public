/**
 * Typed error hierarchy for {@link AgentRunner}. Each error carries a stable
 * machine-readable `code` in addition to the human message so CLI callers can
 * branch on failure without string matching.
 */

/** Durable lifecycle status of a single agent run. */
export type AgentRunStatus = "pending_approval" | "completed" | "failed"

/** Base class for every agent-runtime error. */
export class AgentRunError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

/** The requested run id does not exist in the durable run store. */
export class RunNotFoundError extends AgentRunError {
  readonly runId: string

  constructor(runId: string) {
    super("run_not_found", `No agent run found with id "${runId}".`)
    this.runId = runId
  }
}

/** An attempt was made to approve a run that is not waiting at a gate. */
export class RunNotPendingApprovalError extends AgentRunError {
  readonly runId: string
  readonly status: AgentRunStatus

  constructor(runId: string, status: AgentRunStatus) {
    super(
      "run_not_pending_approval",
      `Agent run "${runId}" is "${status}", not "pending_approval", so it cannot be approved.`,
    )
    this.runId = runId
    this.status = status
  }
}

/** A durable run record failed to parse or serialize. */
export class AgentRunStoreError extends AgentRunError {
  readonly path: string

  constructor(path: string, message: string) {
    super("run_store_error", `Agent run store failed at "${path}": ${message}`)
    this.path = path
  }
}
