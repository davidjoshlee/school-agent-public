import { calculateInputSchema, calculateResultSchema } from "./calculate-tool.js"
import type { AgentRunRecord } from "./run-store.js"

/** One tool call/result pair recovered from a durable {@link AgentRunRecord}. */
export interface ExtractedToolCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
  readonly output: unknown
}

/** One verified `calculate` call: what was computed, how, and its result. */
export interface ComputationLogEntry {
  readonly label: string
  readonly code: string
  readonly result: string | null
  readonly error?: string
}

/**
 * Recover every tool call the agent made across a run's message history,
 * paired with its result, by reading the durable `.agent-runs/<id>.json`
 * record directly — this is evidence extraction, not replay. Tool-call
 * parts live on assistant messages; the matching tool-result part lives on
 * the following tool message. Malformed or unmatched parts are skipped
 * rather than throwing.
 */
export function extractToolCalls(record: AgentRunRecord): readonly ExtractedToolCall[] {
  const calls = new Map<string, { toolName: string; input: unknown }>()
  const outputs = new Map<string, unknown>()
  for (const message of record.messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isToolCallPart(part)) {
          calls.set(part.toolCallId, { toolName: part.toolName, input: part.input })
        }
      }
    }
    if (message.role === "tool" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isToolResultPart(part)) {
          outputs.set(part.toolCallId, toolResultValue(part.output))
        }
      }
    }
  }
  return [...calls.entries()].map(([toolCallId, call]) => ({
    toolCallId,
    toolName: call.toolName,
    input: call.input,
    output: outputs.get(toolCallId) ?? null,
  }))
}

/**
 * Extract just the `calculate` tool's calls as a verifiable computation
 * log the correctness reviewer can check draft numbers against. Calls whose
 * recorded input/output do not match the tool's schema are skipped — a
 * malformed record must never be presented as a verified computation.
 */
export function extractComputations(record: AgentRunRecord): readonly ComputationLogEntry[] {
  const entries: ComputationLogEntry[] = []
  for (const call of extractToolCalls(record)) {
    if (call.toolName !== "calculate") {
      continue
    }
    const input = calculateInputSchema.safeParse(call.input)
    if (!input.success) {
      continue
    }
    const output = calculateResultSchema.safeParse(call.output)
    entries.push({
      label: input.data.label,
      code: input.data.code,
      result: output.success ? output.data.result : null,
      ...(output.success && output.data.error !== undefined ? { error: output.data.error } : {}),
    })
  }
  return entries
}

interface ToolCallPartShape {
  readonly type: "tool-call"
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
}

interface ToolResultPartShape {
  readonly type: "tool-result"
  readonly toolCallId: string
  readonly output: unknown
}

function isToolCallPart(part: unknown): part is ToolCallPartShape {
  return (
    isRecord(part) &&
    part["type"] === "tool-call" &&
    typeof part["toolCallId"] === "string" &&
    typeof part["toolName"] === "string"
  )
}

function isToolResultPart(part: unknown): part is ToolResultPartShape {
  return isRecord(part) && part["type"] === "tool-result" && typeof part["toolCallId"] === "string"
}

// The AI SDK wraps a tool's execute() return value as `{ type: "json", value }`
// (or `{ type: "text", value }` for a string result); unwrap to the raw value.
function toolResultValue(output: unknown): unknown {
  if (isRecord(output) && (output["type"] === "json" || output["type"] === "text")) {
    return output["value"]
  }
  return output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
