/**
 * Orchestration core for `school dogfood`: runs the 10 core-flow checks in
 * order, records pass/fail/duration for each, and persists incrementally so
 * a killed run can resume. Deliberately engine-agnostic — it knows nothing
 * about sync/prep/draft; it only knows how to run a `DogfoodFlow` and record
 * the outcome. The real flows are built by `dogfood-flows.ts` /
 * `dogfood-flows-review.ts`; tests exercise this file with fake flows.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { z } from "zod"

import { readOptional } from "../util/fs.js"
import {
  type DogfoodFlow,
  type DogfoodFlowResult,
  DogfoodFlowSkip,
  type DogfoodResults,
  type DogfoodTarget,
} from "./dogfood-types.js"

const flowResultSchema = z.object({
  name: z.string(),
  kind: z.enum(["auto", "human"]),
  status: z.enum(["pass", "fail", "pending-human", "skipped"]),
  durationMs: z.number(),
  evidence: z.string(),
  note: z.string().optional(),
  error: z.string().optional(),
  human: z.string().optional(),
})
const resultsSchema = z.object({
  startedAt: z.string(),
  course: z.string(),
  week: z.string(),
  assignment: z.string(),
  flows: z.array(flowResultSchema),
})

export type RunDogfoodInput = {
  readonly flows: readonly DogfoodFlow[]
  readonly target: DogfoodTarget
  readonly resultsPath: string
  readonly summaryPath: string
  /** Skip resume: rerun every flow regardless of a prior pass. */
  readonly fresh?: boolean
  readonly now?: () => Date
  readonly log?: (line: string) => void
}

export type RunDogfoodSummary = {
  readonly results: DogfoodResults
  readonly passed: number
  readonly total: number
}

export async function runDogfood(input: RunDogfoodInput): Promise<RunDogfoodSummary> {
  const now = input.now ?? ((): Date => new Date())
  const log = input.log ?? ((line: string): void => console.log(line))
  const prior =
    input.fresh === true ? null : await loadExistingResults(input.resultsPath, input.target)
  const priorByName = new Map(prior?.flows.map((flow) => [flow.name, flow] as const) ?? [])
  const startedAt = prior?.startedAt ?? now().toISOString()
  const flows: DogfoodFlowResult[] = []

  for (const flow of input.flows) {
    const reused = priorByName.get(flow.name)
    const resumable = reused?.status === "pass" || reused?.status === "skipped"
    const result = resumable ? reused : await runOneFlow(flow, now)
    flows.push(result)
    log(renderFlowLine(result, resumable))
    await persist(input, { ...input.target, startedAt, flows })
  }

  const results: DogfoodResults = { ...input.target, startedAt, flows }
  await persist(input, results)
  const passed = flows.filter((flow) => flow.status === "pass").length
  log(`${passed}/${flows.length} passed`)
  return { results, passed, total: flows.length }
}

async function runOneFlow(flow: DogfoodFlow, now: () => Date): Promise<DogfoodFlowResult> {
  const startedAtMs = now().getTime()
  try {
    const outcome = await flow.run()
    const durationMs = now().getTime() - startedAtMs
    return {
      name: flow.name,
      kind: flow.kind,
      status: flow.kind === "human" ? "pending-human" : "pass",
      durationMs,
      evidence: outcome.evidence,
      ...(outcome.note === undefined ? {} : { note: outcome.note }),
      ...(outcome.human === undefined ? {} : { human: outcome.human }),
    }
  } catch (error: unknown) {
    const durationMs = now().getTime() - startedAtMs
    if (error instanceof DogfoodFlowSkip) {
      return {
        name: flow.name,
        kind: flow.kind,
        status: "skipped",
        durationMs,
        evidence: "",
        note: error.message,
      }
    }
    return {
      name: flow.name,
      kind: flow.kind,
      status: "fail",
      durationMs,
      evidence: "",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function renderFlowLine(result: DogfoodFlowResult, resumed: boolean): string {
  const tag = resumed ? `skip (already ${result.status})` : result.status
  const detail = result.status === "fail" ? ` — ${result.error}` : ""
  return `[${tag}] ${result.name} (${result.durationMs}ms)${detail}`
}

async function loadExistingResults(
  path: string,
  target: DogfoodTarget,
): Promise<DogfoodResults | null> {
  const raw = await readOptional(path)
  if (raw === null) {
    return null
  }
  let parsed: DogfoodResults
  try {
    parsed = resultsSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
  const matches =
    parsed.course === target.course &&
    parsed.week === target.week &&
    parsed.assignment === target.assignment
  return matches ? parsed : null
}

async function persist(input: RunDogfoodInput, results: DogfoodResults): Promise<void> {
  await writeFileEnsuringDirectory(input.resultsPath, `${JSON.stringify(results, null, 2)}\n`)
  await writeFileEnsuringDirectory(input.summaryPath, renderSummaryMarkdown(results))
}

async function writeFileEnsuringDirectory(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, "utf8")
}

function renderSummaryMarkdown(results: DogfoodResults): string {
  const passed = results.flows.filter((flow) => flow.status === "pass").length
  const lines = [
    "# Dogfood run",
    "",
    `- Started: ${results.startedAt}`,
    `- Course: ${results.course}`,
    `- Week: ${results.week}`,
    `- Assignment: ${results.assignment}`,
    `- Result: ${passed}/${results.flows.length} passed`,
    "",
    "| # | Flow | Kind | Status | Duration (ms) | Evidence | Human verdict | Note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ]
  results.flows.forEach((flow, index) => {
    lines.push(
      `| ${index + 1} | ${flow.name} | ${flow.kind} | ${flow.status} | ${flow.durationMs} | ${cell(flow.evidence)} | ${cell(flow.human)} | ${cell(flow.note ?? flow.error)} |`,
    )
  })
  return `${lines.join("\n")}\n`
}

function cell(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    return ""
  }
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}
