import vm from "node:vm"

import { tool } from "ai"
import { z } from "zod"

const executionTimeoutMs = 2000
const maxOutputChars = 4000

export const calculateInputSchema = z.object({ label: z.string().min(1), code: z.string().min(1) })
export type CalculateInput = z.infer<typeof calculateInputSchema>
export const calculateResultSchema = z.object({
  label: z.string(),
  result: z.string().nullable(),
  logs: z.array(z.string()),
  error: z.string().optional(),
})
export type CalculateResult = z.infer<typeof calculateResultSchema>

const serializedOutputSchema = z.object({ result: z.string(), logs: z.array(z.string()) })
const executionOptions = { timeout: executionTimeoutMs, displayErrors: false } as const

/* Runs entirely in the new realm. Never inject host objects/functions here. */
const bootstrapSource = `
(() => {
  const stringify = JSON.stringify;
  const cap = (text, limit) => text.length > limit ? text.slice(0, limit) + "…(truncated)" : text;
  const render = (values) => {
    let text = "";
    for (let index = 0; index < values.length; index += 1) {
      if (index > 0) text += " ";
      try { const encoded = stringify(values[index]); text += encoded === undefined ? "undefined" : encoded; }
      catch { text += "[unserializable]"; }
    }
    return text;
  };
  const logs = [];
  let logChars = 0;
  const log = (...values) => {
    if (logChars >= ${maxOutputChars}) return;
    const line = cap(render(values), ${maxOutputChars} - logChars);
    logChars += line.length;
    logs.push(line);
  };
  Object.defineProperty(globalThis, "console", { value: Object.freeze({ log }), writable: false, configurable: false });
  Object.defineProperty(globalThis, "__schoolCalculateSerialize", {
    value: () => {
      let result;
      try { const encoded = stringify(globalThis.__schoolCalculateValue); result = encoded === undefined ? "undefined" : encoded; }
      catch { result = "[unserializable]"; }
      return stringify({ result: cap(result, ${maxOutputChars}), logs });
    }, writable: false, configurable: false,
  });
})();
`

/**
 * Runs arithmetic in a fresh VM realm. No host objects/functions are exposed;
 * dynamic string and WebAssembly code generation are disabled. Results/logs
 * are serialized inside that realm under timeout before host JSON parsing.
 * `node:vm` is not a security boundary: resource exhaustion remains a limit.
 */
export function runCalculation(input: CalculateInput): CalculateResult {
  const sandbox = Object.create(null) as Record<string, unknown>
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  })
  try {
    vm.runInContext(bootstrapSource, context, executionOptions)
    Object.defineProperty(sandbox, "__schoolCalculateValue", {
      value: vm.runInContext(input.code, context, executionOptions),
      writable: false,
      configurable: false,
    })
    const serialized = vm.runInContext("__schoolCalculateSerialize()", context, executionOptions)
    const output = serializedOutputSchema.parse(JSON.parse(requireSerializedText(serialized)))
    return { label: input.label, result: output.result, logs: output.logs }
  } catch {
    return { label: input.label, result: null, logs: [], error: "Calculation failed or timed out." }
  }
}

function requireSerializedText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Calculation sandbox returned a non-text result")
  return value
}

export const calculateTool = tool({
  description:
    "Execute JavaScript to compute one derived numeric value from source figures you supply " +
    "as literals in `code`. Use this for every rate, total, margin, NPV, ratio, or any number " +
    "computed from other numbers — never compute a derived figure by hand or from memory. " +
    "`code`'s final expression value (or the value returned by an IIFE) becomes `result`, " +
    "JSON-serialized; `console.log` output is captured under `logs`. The sandbox has no " +
    "network, filesystem, process, or timer access and a per-evaluation 2-second timeout; " +
    "it is not absolute isolation. Give " +
    '`label` a short description of what this computes (e.g. "gross margin %").',
  inputSchema: calculateInputSchema,
  execute: async (input) => runCalculation(input),
})
