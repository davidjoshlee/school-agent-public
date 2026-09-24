import { randomUUID } from "node:crypto"

import type { AgentRunner, AgentRunResult } from "../agents/runner.js"
import type { SchoolConfig } from "../config/index.js"
import { assertUnderSpendCap, recordModelUsage } from "../models/cost.js"
import { modelMappings } from "../models/index.js"
import type { SchoolIndex } from "../store/db.js"
import { type CoursePeriodRequest, coursePaths, vaultDocumentKinds } from "../store/paths.js"
import { VaultWriter } from "../store/vault.js"
import { vaultSources, vaultStatuses } from "../store/vault-document.js"
import { type DeliverableItem, deliverableFraming, formatDeliverableItems } from "./deliverable.js"
import { type ArtifactRequirements, resolveRequirements } from "./requirements.js"
import { assembleCourseContext, estimateTokens, type TriageFunction } from "./retrieve.js"
import { type ModuleSelection, selectModulesForPeriod } from "./retrieve-selection.js"

// allow: SIZE_OK — the prep-brief engine owns the whole auto-delivered-brief
// pipeline (context assembly, structure resolution, prompt, fabrication guard,
// vault write, token accounting); promptFor/validateBrief are the M1-tuned core
// and splitting them mid-feature would risk the hard-won instrumented behavior.
const requiredSections = [
  "Agenda",
  "Readings",
  "Concepts",
  "Assignments Due",
  "Prep Checklist",
] as const
const markdownLink = /\[[^\]]+\]\(([^)]+)\)/g
// Safety ceiling, not a work-limiting cap: large enough to hold a full case +
// readings as full text. The real guard against a pathological giant file
// (e.g. a 13MB CSV) is the per-file budget skip in retrieve.ts, not this number.
const prepContextBudget = 64_000

export type PrepPeriod = {
  readonly kind: "week" | "session"
  readonly value: string
}

export type PrepCourse = {
  readonly code: string
  readonly canvasId: string
  readonly canvasUrl: string
  readonly aiPolicy: "allowed" | "prohibited"
}

export type GeneratePrepBriefInput = {
  readonly vaultRoot: string
  readonly config: SchoolConfig
  readonly course: PrepCourse
  readonly period: PrepPeriod
  readonly modelOverride?: string
  readonly index: SchoolIndex
  readonly runner: AgentRunner
  readonly triage: TriageFunction
}

export type PrepBriefResult = {
  readonly path: string
  readonly period: PrepPeriod
  readonly model: string
}

export class PrepNoMaterialsError extends Error {
  readonly name = "PrepNoMaterialsError"

  constructor(
    readonly courseCode: string,
    readonly period: PrepPeriod,
  ) {
    super(
      `No posted materials for ${courseCode} ${period.kind} ${period.value}. Sync the course and retry.`,
    )
  }
}

export class PrepGenerationError extends Error {
  readonly name = "PrepGenerationError"

  constructor(
    readonly courseCode: string,
    cause: unknown,
  ) {
    super(
      `Prep generation failed for ${courseCode}. Retry school prep after the model service recovers.`,
      {
        cause,
      },
    )
  }
}

export class PrepContentError extends Error {
  readonly name = "PrepContentError"

  constructor(readonly detail: string) {
    super(`Generated prep brief is unsafe to deliver: ${detail}`)
  }
}

export async function generatePrepBrief(input: GeneratePrepBriefInput): Promise<PrepBriefResult> {
  assertUnderSpendCap({
    index: input.index,
    cap: input.config.cost.maxMonthlySpendUSD,
    now: new Date(),
  })
  const model = prepModel(input.config, input.modelOverride)
  const requestedPeriod = input.period
  const courseRoot = coursePaths(input.vaultRoot, input.course.code, input.course.canvasId).root
  const selection = await selectModulesForPeriod(courseRoot, requestedPeriod)
  const context = await assembleCourseContext({
    vaultRoot: input.vaultRoot,
    course: { code: input.course.code, canvasId: input.course.canvasId },
    task: `${requestedPeriod.kind} ${requestedPeriod.value} module assignment file announcement reading prep`,
    runId: randomUUID(),
    functionName: "prepBrief",
    config: input.config,
    tokenBudget: prepContextBudget,
    triage: input.triage,
    selection,
  })
  if (context.selected.length === 0) {
    throw new PrepNoMaterialsError(input.course.code, requestedPeriod)
  }

  const period = resolvedPeriod(
    input.config,
    requestedPeriod,
    input.index.calendarEventForSession(input.course.canvasId, requestedPeriod.value),
    context.context,
  )
  const requirements = withAnswersSection(
    await resolveRequirements({
      vaultRoot: input.vaultRoot,
      courseCode: input.course.code,
      courseCanvasId: input.course.canvasId,
      defaultSections: requiredSections,
      sources: context.selectedTexts.map((entry) => ({ path: entry.path, text: entry.text })),
    }),
  )
  const generated = await runBrief(
    input.runner,
    input.course.code,
    promptFor(input.course, period, context.context, requirements),
  )
  const content = [period.note, generated.text].filter((part) => part.length > 0).join("\n\n")
  validateBrief(content, new Set(context.sources.map((source) => source.path)), requirements)

  const runId = randomUUID()
  const placement = prepPeriodPlacement(selection)
  const result = await new VaultWriter({
    root: input.vaultRoot,
    gitInit: input.config.vault.gitInit,
  }).write({
    course: input.course,
    kind: vaultDocumentKinds.prep,
    title: `${period.kind} ${period.value}`,
    canvasId: `prep-${period.kind}-${period.value}`,
    canvasUrl: input.course.canvasUrl,
    content,
    dates: { period: `${period.kind}-${period.value}` },
    source: vaultSources.agent,
    status: vaultStatuses.autoFinal,
    model,
    ...(placement === undefined ? {} : { period: placement }),
  })
  recordModelUsage({
    index: input.index,
    model,
    functionName: "prepBrief",
    runId,
    recordedAt: new Date().toISOString(),
    usage: generated.usage,
    fallbackInputTokens: estimateTokens(context.context),
    fallbackOutputTokens: estimateTokens(generated.text),
  })
  return { path: result.path, period: { kind: period.kind, value: period.value }, model }
}

/** Place generated prep beside the module week/milestone selected for its context. */
export function prepPeriodPlacement(selection: ModuleSelection): CoursePeriodRequest | undefined {
  if (selection.mode !== "module") return undefined
  for (const path of selection.paths) {
    const directory = path.split("/")[0] ?? ""
    const match = /^(Week|Milestone)\s+(\d+)(?:\s+-\s+(.+))?$/i.exec(directory)
    const number = match?.[2] === undefined ? Number.NaN : Number.parseInt(match[2], 10)
    if (!Number.isInteger(number) || number < 1) continue
    const label = match?.[3]?.trim()
    return {
      kind: match?.[1]?.toLowerCase() === "milestone" ? "milestone" : "week",
      number,
      ...(label === undefined || label.length === 0 ? {} : { title: label }),
    }
  }
  return undefined
}

type ResolvedPeriod = PrepPeriod & { readonly note: string }

function prepModel(config: SchoolConfig, modelOverride: string | undefined): string {
  const mapping = modelMappings(config, modelOverride).find(
    (candidate) => candidate.key === "models.functions.prepBrief",
  )
  if (mapping === undefined) {
    throw new PrepContentError("the prepBrief model mapping is missing")
  }
  return mapping.model
}

function resolvedPeriod(
  config: SchoolConfig,
  requested: PrepPeriod,
  calendarEvent: ReturnType<SchoolIndex["calendarEventForSession"]>,
  context: string,
): ResolvedPeriod {
  if (config.prep.granularity === "week" || requested.kind === "week") {
    return { ...requested, kind: "week", note: "" }
  }
  // The assembled ## Materials context text is the same evidence the model itself
  // reads, so greping it for "session N" makes the check trust exactly what was
  // retrieved (module titles, doc headers, etc); the manifest/index carry no such
  // human-facing session label to grep, only canvas IDs and dates.
  const schedule = context.split("\n\n## Task", 1)[0] ?? context
  const session = new RegExp(`\\bsession\\s+${escapeRegExp(requested.value)}\\b`, "i")
  if (calendarEvent !== null || session.test(schedule)) {
    return { ...requested, note: "" }
  }
  return {
    kind: "week",
    value: requested.value,
    note: "Session structure was not detected; generated a week-level brief.",
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function runBrief(
  runner: AgentRunner,
  courseCode: string,
  prompt: string,
): Promise<{ readonly text: string; readonly usage: AgentRunResult["usage"] }> {
  try {
    const result = await runner.run(prompt)
    if (result.status !== "completed" || result.text === null) {
      throw new PrepContentError("the agent did not complete the auto-delivered brief")
    }
    return { text: result.text.trim(), usage: result.usage }
  } catch (error: unknown) {
    if (error instanceof PrepContentError) {
      throw error
    }
    throw new PrepGenerationError(courseCode, error)
  }
}

// The name loosely matched against declared sections to decide whether a
// detected deliverable needs its own injected "Answers" section, or can
// reuse one the class guidance already declares (e.g. "Discussion Answers").
const answersSectionName = /answers?|questions?/i

/**
 * When a deliverable was detected and no declared section already looks like
 * an answers section, append one named "Answers" so `validateBrief`'s
 * "exactly these H2 sections" contract stays coherent with the prompt's
 * per-item answer requirement. A no-op when nothing was detected or an
 * answers-ish section is already declared.
 */
function withAnswersSection(requirements: ArtifactRequirements): ArtifactRequirements {
  if (requirements.deliverable.kind === "none") {
    return requirements
  }
  if (requirements.sections.some((section) => answersSectionName.test(section))) {
    return requirements
  }
  return { ...requirements, sections: [...requirements.sections, "Answers"] }
}

function answersSection(sections: readonly string[]): string {
  return sections.find((section) => answersSectionName.test(section)) ?? "Answers"
}

function deliverableInstructions(requirements: ArtifactRequirements): string {
  const { deliverable } = requirements
  if (deliverable.kind === "none") {
    return ""
  }
  const section = answersSection(requirements.sections)
  const framing = deliverableFraming(deliverable, {
    questions: "answering the discussion questions below",
    requirements: "producing the required deliverable described below",
  })
  const items = formatDeliverableItems(deliverable)
  return [
    `Under ## ${section}, actually complete this session's task: ${framing}, grounded in the materials.`,
    `Include exactly one \`### <id>. <item text>\` subsection per item below (copy the heading verbatim), each answered in full from the materials — never a restatement of the question.`,
    items,
  ].join("\n\n")
}

function promptFor(
  course: PrepCourse,
  period: ResolvedPeriod,
  context: string,
  structure: ArtifactRequirements,
): string {
  const { sections, readingsSection, instructions } = structure
  const example = readingsExample(context)
  const linkRule =
    example === null
      ? 'Target each link at one of the exact "### path" headers in the Materials below.'
      : `Valid Reading link (target copied verbatim from a Materials header): ${example}`
  const readingInstruction =
    readingsSection === null
      ? "Where you cite a source, use a Markdown link of the form [readable label](vault-relative-path)."
      : `Under ## ${readingsSection}, list the 1-3 most relevant readable documents (case/reading files, slides, pages — NOT the assignment's own submission form) from the Materials below as Markdown links. ${readingsSection} must NEVER be prose, a bare title, a bullet of plain text, or the phrase "no readings" / "not posted" while Materials has at least one document.`
  const linkPlacement =
    readingsSection === null
      ? "The ONLY Markdown links in the entire brief are the reading links; do not place links in any other section."
      : `The ONLY Markdown links in the entire brief are the ${readingsSection} links; do not place links in ${sections
          .filter((section) => section !== readingsSection)
          .join(", ")}.`
  return [
    `Do the ${period.kind} ${period.value} prep for ${course.code}: read the supplied readings and course materials, then return the FINISHED prep as a Markdown brief.`,
    'The brief is the completed preparation itself, not a plan or a summary of what to prep: the readings actually read and digested, the key concepts actually synthesized. Distill the substance — state and explain the key concepts, definitions, frameworks, and arguments the materials contain, well enough that the student walks into class already knowing them. Never substitute a pointer ("read X", "review Y", "go over Z") for what X, Y, and Z actually say.',
    `Return Markdown with exactly these H2 sections; write each heading verbatim: ${sections.join(", ")}.`,
    readingInstruction,
    'Every Markdown link is of the form [readable label](vault-relative-path). Copy the path EXACTLY from one of the "### path" headers in Materials: no edits, no trailing punctuation, nothing extra inside the parentheses.',
    linkRule,
    linkPlacement,
    "Use only the supplied course context; state when an item is not posted rather than guessing.",
    instructions.length > 0 ? `## Course guidance\n${instructions}` : "",
    deliverableInstructions(structure),
    context,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n")
}

function readingsExample(context: string): string | null {
  const path = context.match(/^### ([^\n]*\.md)\s*$/m)?.[1]
  if (path === undefined || path.trim().length === 0) {
    return null
  }
  const label =
    path
      .split("/")
      .at(-1)
      ?.replace(/\.(?:summary\.)?md$/, "") ?? "Reading"
  return `[${label}](${path})`
}

function validateBrief(
  content: string,
  sourcePaths: ReadonlySet<string>,
  requirements: ArtifactRequirements,
): void {
  const { sections, readingsSection, deliverable } = requirements
  for (const section of sections) {
    if (!new RegExp(`^## ${section}$`, "m").test(content)) {
      throw new PrepContentError(`missing required section: ${section}`)
    }
  }
  if (readingsSection !== null) {
    const readings = sectionBody(content, readingsSection)
    if (readings === undefined || markdownLinksFor(readings).length === 0) {
      throw new PrepContentError(`${readingsSection} must include at least one vault-relative link`)
    }
  }
  for (const path of markdownLinksFor(content)) {
    if (!sourcePaths.has(path)) {
      throw new PrepContentError(`citation does not resolve to supplied vault context: ${path}`)
    }
  }
  if (deliverable.kind !== "none") {
    validateAnswers(content, sections, deliverable.items)
  }
}

function sectionBody(content: string, section: string): string | undefined {
  return content.match(
    new RegExp(`^## ${escapeRegExp(section)}$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"),
  )?.[1]
}

// Every detected item must appear as its own "### <id>. <text>" subsection
// under the answers section, with non-empty answer body — the coverage
// contract that makes the brief actually address what the assignment asks.
function validateAnswers(
  content: string,
  sections: readonly string[],
  items: readonly DeliverableItem[],
): void {
  const body = sectionBody(content, answersSection(sections)) ?? ""
  for (const item of items) {
    const heading = new RegExp(
      `^### ${escapeRegExp(item.id)}\\.\\s*${escapeRegExp(item.text)}\\s*$([\\s\\S]*?)(?=^### |(?![\\s\\S]))`,
      "m",
    )
    const answer = heading.exec(body)?.[1]?.trim() ?? ""
    if (answer.length === 0) {
      throw new PrepContentError(`missing or empty answer for item ${item.id}: ${item.text}`)
    }
  }
}

function markdownLinksFor(content: string): readonly string[] {
  return [...content.matchAll(markdownLink)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  )
}
