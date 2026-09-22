/**
 * `guidance propose`: the agent DRAFTS a `## Brief structure` +
 * per-class-instructions proposal from what the course itself already
 * shows — the human-gated "learning" step for per-class steerability
 * (`guidance.ts`/`requirements.ts`).
 *
 * THE SAFETY PROPERTY: this module writes ONLY to
 * `coursePaths(...).guidanceProposal` (`guidance/prep-guidance.proposed.md`)
 * and never reads or writes the user-owned `guidance/prep-guidance.md` —
 * `guidance/**` is a user-owned vault zone (see the project instructions). The proposal is
 * a sibling file the user reviews and renames themselves.
 *
 * Context assembly (syllabus + a handful of recent assignments + graded
 * feedback, bounded) lives in `guidance-propose-context.ts`.
 */
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"

import type { AgentRunner, AgentRunResult } from "../agents/runner.js"
import type { SchoolConfig } from "../config/index.js"
import { assertUnderSpendCap, recordModelUsage } from "../models/cost.js"
import { modelMappings } from "../models/index.js"
import type { SchoolIndex } from "../store/db.js"
import { coursePaths, vaultDocumentKinds } from "../store/paths.js"
import {
  createVaultFrontmatter,
  renderVaultDocument,
  vaultSources,
  vaultStatuses,
} from "../store/vault-document.js"
import { readOptional } from "../util/fs.js"
import type { Deliverable } from "./deliverable.js"
import { parseStructure } from "./guidance.js"
import { assembleGuidanceContext } from "./guidance-propose-context.js"
import { estimateTokens } from "./retrieve.js"

export type GuidanceProposeCourse = {
  readonly code: string
  readonly canvasId: string
  readonly canvasUrl: string
  readonly aiPolicy: "allowed" | "prohibited"
}

export type ProposeGuidanceInput = {
  readonly vaultRoot: string
  readonly config: SchoolConfig
  readonly course: GuidanceProposeCourse
  readonly modelOverride?: string
  readonly index: SchoolIndex
  readonly runner: AgentRunner
}

export type ProposeGuidanceResult = {
  readonly path: string
  readonly model: string
}

export class GuidanceProposeGenerationError extends Error {
  readonly name = "GuidanceProposeGenerationError"

  constructor(
    readonly courseCode: string,
    cause: unknown,
  ) {
    super(`Guidance proposal generation failed for ${courseCode}.`, { cause })
  }
}

export class GuidanceProposeContentError extends Error {
  readonly name = "GuidanceProposeContentError"

  constructor(readonly detail: string) {
    super(`Generated guidance proposal is unsafe to write: ${detail}`)
  }
}

export async function proposeGuidance(input: ProposeGuidanceInput): Promise<ProposeGuidanceResult> {
  assertUnderSpendCap({
    index: input.index,
    cap: input.config.cost.maxMonthlySpendUSD,
    now: new Date(),
  })
  const model = playbookUpdateModel(input.config, input.modelOverride)
  const paths = coursePaths(input.vaultRoot, input.course.code, input.course.canvasId)
  const { context, deliverable, existingStructure } = await assembleGuidanceContext(
    paths,
    input.course.code,
  )
  const generated = await runProposal(
    input.runner,
    input.course.code,
    promptFor(context, deliverable, existingStructure),
  )

  // Round-trip is a hard requirement: a proposal the engines can't read
  // back via `parseStructure` is worthless, so refuse to write it.
  const structure = parseStructure(generated.text)
  if (structure.sections.length === 0) {
    throw new GuidanceProposeContentError(
      "generated proposal declares no '## Brief structure' sections that parse back via parseStructure",
    )
  }

  const document = renderVaultDocument(
    createVaultFrontmatter({
      canvasId: "guidance-proposal",
      canvasUrl: input.course.canvasUrl,
      type: vaultDocumentKinds.guidance,
      content: generated.text,
      source: vaultSources.agent,
      status: vaultStatuses.draft,
      aiPolicy: input.course.aiPolicy,
      model,
    }),
    generated.text,
  )
  // Never the user-owned guidance/prep-guidance.md: `paths.guidanceProposal`
  // is a fixed, distinct sibling path (src/store/paths.ts).
  await mkdir(paths.guidance, { recursive: true })
  await writeIfChanged(paths.guidanceProposal, document)

  recordModelUsage({
    index: input.index,
    model,
    functionName: "playbookUpdate",
    runId: randomUUID(),
    recordedAt: new Date().toISOString(),
    usage: generated.usage,
    fallbackInputTokens: estimateTokens(context),
    fallbackOutputTokens: estimateTokens(generated.text),
  })
  return { path: paths.guidanceProposal, model }
}

function promptFor(
  context: string,
  deliverable: Deliverable,
  existingStructure: readonly string[] | null,
): string {
  const deliverableNote =
    deliverable.kind === "none"
      ? "No explicit questions/requirements cue was detected in the sampled assignments."
      : `A '${deliverable.cue}' cue was detected (kind: ${deliverable.kind}) in the sampled assignments — that is evidence about the course's GRADED deliverable, to fold into the free-form prose, NOT about the shape of '## Brief structure'.`
  const baselineNote =
    existingStructure === null
      ? "No '## Brief structure' is declared for this course yet — infer one from scratch, but only for the weekly prep brief (see framing below)."
      : `The course ALREADY declares this '## Brief structure' baseline: ${existingStructure.join(", ")}. Treat it as the starting point: keep what still fits this class, and only add, rename, or drop a section where the evidence below clearly calls for it. Do not invent a wholesale competing structure.`
  return [
    "Draft a per-class steerability guidance file for this course's WEEKLY PREP BRIEF, from the syllabus, recent assignments, and any graded feedback below.",
    "CRITICAL FRAMING — read this before writing anything: '## Brief structure' declares the H2 sections of the WEEKLY PREP BRIEF ONLY, the artifact a student reads BEFORE walking into a class session, built from digesting that week's readings and synthesizing concepts. It is NEVER the shape of a graded submission (a case write-up, a policy/CEO memo, a problem set, a project deliverable). Concretely: prep-brief sections read like 'Concepts', 'Readings synthesis', 'Discussion prep', 'Key Takeaways', 'Prep Checklist' — they NEVER read like a case write-up's 'Facts / Issue / Analysis / Recommendation' or a memo's 'Non-Market Issue / Stakeholder Analysis / Recommendation / Implementation'. If what you see in the assignments/feedback below describes how a graded deliverable is structured, that observation belongs ONLY in the free-form prose, never copied into '## Brief structure'.",
    baselineNote,
    "First write free-form prose instructions (no heading required) — keep this section as rich and specific as the material supports. Describe how this class actually works and exactly what the professor rewards when students turn in the course's MAJOR GRADED DELIVERABLES — quote or closely paraphrase the graded feedback's actual wording and specifics (named frameworks, required precision, what earned/lost credit) rather than generic study advice. State plainly that these are the standing expectations for the graded deliverables specifically, separate from the weekly prep brief's own structure below.",
    "Then, as the VERY LAST thing in your response with nothing after it, add a '## Brief structure' section whose body lists ONLY the H2 section names the weekly PREP BRIEF (never a deliverable) should contain, one per line (plain text, no bullets, no other prose in this section).",
    deliverableNote,
    "Never fabricate specifics not supported by the material below; state uncertainty plainly instead.",
    context,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n")
}

async function runProposal(
  runner: AgentRunner,
  courseCode: string,
  prompt: string,
): Promise<{ readonly text: string; readonly usage: AgentRunResult["usage"] }> {
  try {
    const result = await runner.run(prompt)
    if (result.status !== "completed" || result.text === null) {
      throw new GuidanceProposeContentError("the agent did not complete the guidance proposal")
    }
    return { text: result.text.trim(), usage: result.usage }
  } catch (error: unknown) {
    if (error instanceof GuidanceProposeContentError) throw error
    throw new GuidanceProposeGenerationError(courseCode, error)
  }
}

function playbookUpdateModel(config: SchoolConfig, modelOverride: string | undefined): string {
  const mapping = modelMappings(config, modelOverride).find(
    (candidate) => candidate.key === "models.functions.playbookUpdate",
  )
  if (mapping === undefined) {
    throw new GuidanceProposeContentError("the playbookUpdate model mapping is missing")
  }
  return mapping.model
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  if ((await readOptional(path)) === content) return
  await writeFile(path, content, "utf8")
}
