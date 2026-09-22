import { describe, expect, it } from "vitest"
import type { AgentRunRecord } from "../../src/agents/run-store.js"
import { extractComputations, extractToolCalls } from "../../src/agents/run-tools.js"

const base = {
  id: "run-1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  resultText: "draft text",
  error: null,
  status: "completed" as const,
  pendingApproval: null,
  usage: null,
}

function recordWithMessages(messages: AgentRunRecord["messages"]): AgentRunRecord {
  return { ...base, messages }
}

describe("extractToolCalls", () => {
  it("pairs tool-call parts on assistant messages with tool-result parts on tool messages", () => {
    // Given: a run history with one calculate call and one gate call.
    const record = recordWithMessages([
      { role: "user", content: "draft it" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "calc-1",
            toolName: "calculate",
            input: { label: "margin", code: "(10 - 6) / 10" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "calc-1",
            toolName: "calculate",
            output: { type: "json", value: { label: "margin", result: "0.4", logs: [] } },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          {
            type: "tool-call",
            toolCallId: "gate-1",
            toolName: "assignment_gate",
            input: { artifact: "draft" },
          },
        ],
      },
    ])

    // When: tool calls are extracted.
    const calls = extractToolCalls(record)

    // Then: both calls are recovered with their matched outputs.
    expect(calls).toHaveLength(2)
    const calc = calls.find((call) => call.toolCallId === "calc-1")
    expect(calc).toMatchObject({
      toolName: "calculate",
      input: { label: "margin", code: "(10 - 6) / 10" },
      output: { label: "margin", result: "0.4", logs: [] },
    })
    const gate = calls.find((call) => call.toolCallId === "gate-1")
    expect(gate).toMatchObject({ toolName: "assignment_gate", output: null })
  })

  it("returns an empty list for a run with no tool calls", () => {
    // Given/When: a plain text-only run.
    const record = recordWithMessages([
      { role: "user", content: "discuss it" },
      { role: "assistant", content: "an answer" },
    ])

    // Then: no tool calls are found.
    expect(extractToolCalls(record)).toEqual([])
  })
})

describe("extractComputations", () => {
  it("builds a computation log from calculate calls only", () => {
    // Given: a mixed run with a calculate call and a gate call.
    const record = recordWithMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "calc-1",
            toolName: "calculate",
            input: { label: "gross margin %", code: "(120 - 72) / 120" },
          },
          {
            type: "tool-call",
            toolCallId: "gate-1",
            toolName: "assignment_gate",
            input: { artifact: "draft" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "calc-1",
            toolName: "calculate",
            output: { type: "json", value: { label: "gross margin %", result: "0.4", logs: [] } },
          },
        ],
      },
    ])

    // When: the computation log is extracted.
    const computations = extractComputations(record)

    // Then: only the calculate call is present, with no error.
    expect(computations).toEqual([
      { label: "gross margin %", code: "(120 - 72) / 120", result: "0.4" },
    ])
  })

  it("carries a computation's error through so the reviewer can flag it", () => {
    // Given: a calculate call whose sandboxed execution failed.
    const record = recordWithMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "calc-1",
            toolName: "calculate",
            input: { label: "npv", code: "1 / 0 === Infinity ? undefined() : 0" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "calc-1",
            toolName: "calculate",
            output: {
              type: "json",
              value: { label: "npv", result: null, logs: [], error: "undefined is not a function" },
            },
          },
        ],
      },
    ])

    // When: the computation log is extracted.
    const computations = extractComputations(record)

    // Then: the error is preserved on the log entry.
    expect(computations).toEqual([
      {
        label: "npv",
        code: "1 / 0 === Infinity ? undefined() : 0",
        result: null,
        error: "undefined is not a function",
      },
    ])
  })

  it("returns an empty log when no calculate calls were made", () => {
    // Given/When: a run with only a gate tool call.
    const record = recordWithMessages([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "gate-1", toolName: "assignment_gate", input: {} },
        ],
      },
    ])

    // Then: the computation log is empty, not thrown.
    expect(extractComputations(record)).toEqual([])
  })

  it("skips a calculate call whose recorded input does not match the tool schema", () => {
    // Given: a malformed tool-call input (missing required fields).
    const record = recordWithMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "calc-1",
            toolName: "calculate",
            input: { code: "1+1" },
          },
        ],
      },
    ])

    // Then: the malformed entry is skipped rather than surfaced as a fabricated computation.
    expect(extractComputations(record)).toEqual([])
  })
})
