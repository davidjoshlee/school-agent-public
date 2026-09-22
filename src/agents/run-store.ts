import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { type ModelMessage, modelMessageSchema } from "ai"
import { z } from "zod"

import { hasErrorCode } from "../util/errors.js"
import { AgentRunStoreError, RunNotFoundError } from "./errors.js"

/** The pending human-approval request a run is parked on, if any. */
export interface PendingApproval {
  readonly approvalId: string
  readonly toolCallId: string
  readonly toolName: string
}

/** Real token usage for the most recent `generate()` call on a run. */
export interface AgentRunUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  /** Cached-input tokens the provider reported, if any (null when unreported). */
  readonly cachedInputTokens: number | null
  /**
   * The AI Gateway's per-call generation id, read from
   * `result.providerMetadata?.gateway?.generationId` — free on every
   * `generateText`/agent result, kept here so a later `cost reconcile` can
   * look up the gateway's authoritative cost for this exact call. Null when
   * the SDK reported no gateway provider metadata (e.g. a non-gateway model,
   * or a record written before this field existed).
   */
  readonly generationId: string | null
}

interface AgentRunBase {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  /** The AI SDK message history required to resume this run across processes. */
  readonly messages: ModelMessage[]
  readonly resultText: string | null
  readonly error: string | null
  /** Usage from the most recent `generate()` call, if the SDK reported any. Absent on records written before Stage A. */
  readonly usage?: AgentRunUsage | null
}

/** The run is parked at a gate and awaiting an explicit human decision. */
export interface PendingApprovalRunRecord extends AgentRunBase {
  readonly status: "pending_approval"
  readonly pendingApproval: PendingApproval
}

/** The run finished and (if it gated) every gate was approved. */
export interface CompletedRunRecord extends AgentRunBase {
  readonly status: "completed"
  readonly pendingApproval: null
}

/** The run failed; `error` carries the reason. */
export interface FailedRunRecord extends AgentRunBase {
  readonly status: "failed"
  readonly pendingApproval: null
}

/** Durable per-run state. `pending_approval` always carries a `PendingApproval`. */
export type AgentRunRecord = PendingApprovalRunRecord | CompletedRunRecord | FailedRunRecord

const pendingApprovalSchema = z.object({
  approvalId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
})

const agentRunUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  // Records written before this field existed carry no `generationId` at all.
  generationId: z.string().nullable().default(null),
})

const agentRunBaseSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(modelMessageSchema),
  resultText: z.string().nullable(),
  error: z.string().nullable(),
  // Records written before Stage A carry no `usage` field at all.
  usage: agentRunUsageSchema.nullable().default(null),
})

/** Parse-don't-validate: every record is parsed at the filesystem boundary. */
const agentRunRecordSchema = z.discriminatedUnion("status", [
  z.object({
    ...agentRunBaseSchema.shape,
    status: z.literal("pending_approval"),
    pendingApproval: pendingApprovalSchema,
  }),
  z.object({
    ...agentRunBaseSchema.shape,
    status: z.literal("completed"),
    pendingApproval: z.null(),
  }),
  z.object({
    ...agentRunBaseSchema.shape,
    status: z.literal("failed"),
    pendingApproval: z.null(),
  }),
])

/** Repo-root `.agent-runs` regardless of the process working directory. */
const DEFAULT_RUNS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".agent-runs")

/**
 * Durable per-run state at `.agent-runs/<id>.json`. Writes are atomic
 * (write a temp file, then rename) so a hard `kill -9` mid-write cannot
 * produce a truncated record.
 */
export class AgentRunStore {
  readonly runsDir: string

  constructor(runsDir: string = DEFAULT_RUNS_DIR) {
    this.runsDir = runsDir
  }

  private pathFor(runId: string): string {
    return join(this.runsDir, `${runId}.json`)
  }

  async save(record: AgentRunRecord): Promise<void> {
    await mkdir(this.runsDir, { recursive: true })
    const tempPath = join(this.runsDir, `${record.id}.${randomUUID()}.tmp`)
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8")
    await rename(tempPath, this.pathFor(record.id))
  }

  async get(runId: string): Promise<AgentRunRecord> {
    const path = this.pathFor(runId)
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) {
        throw new RunNotFoundError(runId)
      }
      throw new AgentRunStoreError(path, error instanceof Error ? error.message : String(error))
    }
    try {
      return agentRunRecordSchema.parse(JSON.parse(raw))
    } catch (error: unknown) {
      throw new AgentRunStoreError(path, error instanceof Error ? error.message : String(error))
    }
  }

  async list(): Promise<AgentRunRecord[]> {
    let entries: string[]
    try {
      entries = await readdir(this.runsDir)
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) {
        return []
      }
      throw new AgentRunStoreError(
        this.runsDir,
        error instanceof Error ? error.message : String(error),
      )
    }
    const ids = entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5))
    return Promise.all(ids.map((id) => this.get(id)))
  }
}
