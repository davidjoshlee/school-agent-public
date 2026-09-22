import { randomUUID } from "node:crypto"
import type { Context } from "@ai-sdk/provider-utils"
import {
  type LanguageModel,
  type ModelMessage,
  modelMessageSchema,
  type StopCondition,
  type ToolApprovalConfiguration,
  ToolLoopAgent,
  type ToolSet,
} from "ai"
import { z } from "zod"

import type { AgentRunStatus } from "./errors.js"
import { RunNotPendingApprovalError } from "./errors.js"
import type {
  AgentRunRecord,
  AgentRunUsage,
  PendingApproval,
  PendingApprovalRunRecord,
} from "./run-store.js"
import { AgentRunStore } from "./run-store.js"

/** Default cap on a single generate() call so a stalled gateway request can
 * never hang a run indefinitely (mirrors the Canvas HTTP timeout). */
const defaultGenerateTimeoutMs = 300_000

export class AgentTimeoutError extends Error {
  readonly name = "AgentTimeoutError"
  constructor(readonly timeoutMs: number) {
    super(`Agent generation exceeded ${timeoutMs}ms and was aborted`)
  }
}

/** The approved-run-request-outcome returned by every {@link AgentRunner} method. */
export interface AgentRunResult {
  readonly runId: string
  readonly status: AgentRunStatus
  readonly text: string | null
  readonly pendingApproval: PendingApproval | null
  /** Real token usage for THIS generate() call (not accumulated across a whole run). Null/absent if the SDK reported none. */
  readonly usage?: AgentRunUsage | null
}

/** Configuration for an {@link AgentRunner} backed by AI SDK Core. */
export interface AgentRunnerConfig {
  /** Directory for durable `.agent-runs/<id>.json` records. */
  readonly runsDir: string
  /** The language model the agent turns run on. */
  readonly model: LanguageModel
  /** Optional system instructions. */
  readonly instructions?: string
  /** The tools exposed to the agent. */
  readonly tools: ToolSet
  /** Per-tool approval policy, e.g. `{ gated_tool: "user-approval" }`. */
  readonly toolApproval?: ToolApprovalConfiguration<ToolSet, Context>
  /** Cap on a single generate() call in ms; defaults to {@link defaultGenerateTimeoutMs}. */
  readonly generateTimeoutMs?: number
  /** Optional loop stop condition (defaults to the framework's step cap). */
  readonly stopWhen?: StopCondition<ToolSet, Context> | StopCondition<ToolSet, Context>[]
}

/**
 * The agent-runtime seam. Engines call `run`/`approve`/`revise` and never
 * touch AI SDK or eve directly; the chosen backend is an implementation detail
 * behind this interface. Every method reads/writes durable state at
 * `.agent-runs/<id>.json` so a run parked at a gate survives process death.
 */
export interface AgentRunner {
  run(prompt: string): Promise<AgentRunResult>
  approve(runId: string): Promise<AgentRunResult>
  revise(runId: string, feedback: string): Promise<AgentRunResult>
  get(runId: string): Promise<AgentRunRecord>
  list(): Promise<AgentRunRecord[]>
}

interface ToolApprovalRequestPart {
  type: "tool-approval-request"
  approvalId: string
  toolCall: { toolCallId: string; toolName: string }
}

function isToolApprovalRequest(part: unknown): part is ToolApprovalRequestPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    "approvalId" in part &&
    "toolCall" in part &&
    (part as { type: unknown }).type === "tool-approval-request"
  )
}

/**
 * AI SDK Core implementation of {@link AgentRunner}. It drives a
 * `ToolLoopAgent`, pauses durably at a tool gate via `toolApproval`, and
 * resumes by re-supplying the message history plus a `tool-approval-response`.
 *
 * The backend is deliberately in-process: `run`/`approve`/`revise` each build a
 * fresh agent from the config, so a separate CLI process can pick up a paused
 * run purely from `.agent-runs/<id>.json` — no server, no session pinned to a
 * live process.
 *
 * > Backend decision: `eve` was evaluated and dropped. Eve's runtime is a
 * > standalone Nitro HTTP server with no in-process invocation API, which
 * > cannot be driven from a discrete CLI process; AI SDK Core runs the agent
 * > in-process and gates directly on our durable filesystem state.
 */
export class AISDKAgentRunner implements AgentRunner {
  readonly #config: AgentRunnerConfig
  readonly #store: AgentRunStore

  constructor(config: AgentRunnerConfig) {
    this.#config = config
    this.#store = new AgentRunStore(config.runsDir)
  }

  private buildAgent(): ToolLoopAgent<never, ToolSet, Context, never> {
    const config = this.#config
    return new ToolLoopAgent({
      model: config.model,
      tools: config.tools,
      ...(config.instructions != null ? { instructions: config.instructions } : {}),
      ...(config.toolApproval != null ? { toolApproval: config.toolApproval } : {}),
      ...(config.stopWhen != null ? { stopWhen: config.stopWhen } : {}),
    })
  }

  private async generateWithTimeout(inputMessages: ModelMessage[]) {
    const timeoutMs = this.#config.generateTimeoutMs ?? defaultGenerateTimeoutMs
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new AgentTimeoutError(timeoutMs))
      }, timeoutMs)
    })
    try {
      // Race the generation against a hard timeout so a stalled gateway request
      // fails the run cleanly instead of hanging it forever; abort the request
      // too, so a well-behaved provider stops work and the process can exit.
      return await Promise.race([
        this.buildAgent().generate({ messages: inputMessages, abortSignal: controller.signal }),
        timeout,
      ])
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }

  private findApprovalRequest(result: { content: readonly unknown[] }): PendingApproval | null {
    for (const part of result.content) {
      if (isToolApprovalRequest(part)) {
        return {
          approvalId: part.approvalId,
          toolCallId: part.toolCall.toolCallId,
          toolName: part.toolCall.toolName,
        }
      }
    }
    return null
  }

  private async generateInto(
    runId: string,
    inputMessages: ModelMessage[],
    previous: AgentRunRecord | null,
  ): Promise<AgentRunRecord> {
    const result = await this.generateWithTimeout(inputMessages)
    const pendingApproval = this.findApprovalRequest(result)
    const now = new Date().toISOString()
    const base = {
      id: runId,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      messages: [...inputMessages, ...result.responseMessages],
      resultText: result.text || null,
      error: null,
      usage: usageFrom(result.usage, gatewayGenerationId(result.providerMetadata)),
    }
    const record: AgentRunRecord =
      pendingApproval == null
        ? { ...base, status: "completed", pendingApproval: null }
        : { ...base, status: "pending_approval", pendingApproval }
    await this.#store.save(record)
    return record
  }

  private toResult(record: AgentRunRecord): AgentRunResult {
    return {
      runId: record.id,
      status: record.status,
      text: record.resultText,
      pendingApproval: record.pendingApproval,
      usage: record.usage ?? null,
    }
  }

  async run(prompt: string): Promise<AgentRunResult> {
    const runId = randomUUID()
    const inputMessages: ModelMessage[] = [{ role: "user", content: prompt }]
    return this.toResult(await this.generateInto(runId, inputMessages, null))
  }

  async approve(runId: string): Promise<AgentRunResult> {
    const existing = await this.#store.get(runId)
    if (existing.status !== "pending_approval") {
      throw new RunNotPendingApprovalError(runId, existing.status)
    }
    const inputMessages = approvalMessages(existing, true)
    return this.toResult(await this.generateInto(runId, inputMessages, existing))
  }

  async revise(runId: string, feedback: string): Promise<AgentRunResult> {
    let current = await this.#store.get(runId)
    // `revise` applies to a gated draft: cancel the parked action first so the
    // message history carries no dangling tool call, then submit the feedback.
    if (current.status === "pending_approval") {
      current = await this.generateInto(runId, approvalMessages(current, false), current)
    }
    const inputMessages = followUpMessages(current, feedback)
    return this.toResult(await this.generateInto(runId, inputMessages, current))
  }

  get(runId: string): Promise<AgentRunRecord> {
    return this.#store.get(runId)
  }

  list(): Promise<AgentRunRecord[]> {
    return this.#store.list()
  }
}

/** Build the message history that grants or denies a pending approval. */
function approvalMessages(record: PendingApprovalRunRecord, approved: boolean): ModelMessage[] {
  return z.array(modelMessageSchema).parse([
    ...record.messages,
    {
      role: "tool",
      content: [
        {
          type: "tool-approval-response",
          approvalId: record.pendingApproval.approvalId,
          approved,
        },
      ],
    },
  ])
}

/** Build the resume message history that submits follow-up feedback. */
function followUpMessages(record: AgentRunRecord, feedback: string): ModelMessage[] {
  return z
    .array(modelMessageSchema)
    .parse([...record.messages, { role: "user", content: feedback }])
}

/**
 * Map the AI SDK's `LanguageModelUsage` (summed across every step of one
 * `generate()` call) onto our durable, storage-shaped usage record. Null when
 * the SDK genuinely reports no input/output counts — callers fall back to
 * `estimateTokens` only in that case.
 */
function usageFrom(
  usage: {
    readonly inputTokens: number | undefined
    readonly outputTokens: number | undefined
    readonly inputTokenDetails?: { readonly cacheReadTokens: number | undefined }
  },
  generationId: string | undefined,
): AgentRunUsage | null {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return null
  }
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
    generationId: generationId ?? null,
  }
}

/**
 * Read the AI Gateway's per-call generation id off `providerMetadata`. The
 * gateway attaches it inline on every result at `providerMetadata.gateway.
 * generationId` (confirmed against `@ai-sdk/gateway`'s
 * `GatewayGenerationInfo`/error-class `generationId` fields; `providerMetadata`
 * itself is typed only as `Record<string, Record<string, JSONValue>>`, so the
 * value is narrowed to a string here rather than trusted from the type).
 */
function gatewayGenerationId(
  providerMetadata: Record<string, Record<string, unknown>> | undefined,
): string | undefined {
  const value = providerMetadata?.["gateway"]?.["generationId"]
  return typeof value === "string" ? value : undefined
}
