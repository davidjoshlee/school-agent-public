import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { extractComputations } from "../agents/run-tools.js"
import type { AgentRunner, AgentRunResult } from "../agents/runner.js"
import { fileIdsFromHtml } from "../canvas/sync-render.js"
import type { SchoolConfig } from "../config/index.js"
import { assertUnderSpendCap, recordModelUsage } from "../models/cost.js"
import type { SchoolIndex } from "../store/db.js"
import {
  assignmentPaths,
  courseDocumentPath,
  coursePaths,
  humanPathSegment,
  slugify,
  vaultDocumentKinds,
  xlsxSiblingPath,
} from "../store/paths.js"
import { parseVaultDocument, VaultWriter, vaultSources, vaultStatuses } from "../store/vault.js"
import { buildXlsx } from "../store/xlsx.js"
import { sheetsFromDraft } from "../store/xlsx-extract.js"
import { readDirectory, readOptional } from "../util/fs.js"
import { lineDiff } from "./assignment-diff.js"
import {
  type AssignmentProvenance,
  assignmentProvenanceSchema,
  parseAssignmentProvenance,
  renderAssignmentProvenance,
  withoutAssignmentProvenance,
} from "./assignment-provenance.js"
import { selfReviewDraft, withCorrectnessCheck } from "./assignment-review.js"
import { extractSubmissionContent } from "./assignment-submission.js"
import {
  type Deliverable,
  type DeliverableSource,
  deliverableFraming,
  formatDeliverableItems,
} from "./deliverable.js"
import { type ArtifactRequirements, resolveRequirements } from "./requirements.js"
import type { TriageFunction } from "./retrieve.js"
import { assembleCourseContext, estimateTokens } from "./retrieve.js"
import { selectModulesForAssignment } from "./retrieve-selection.js"

export { assignmentProvenanceSchema, parseAssignmentProvenance } from "./assignment-provenance.js"

// allow: SIZE_OK — the draft engine owns the whole gated-draft pipeline
// (context assembly, requirements resolution, prompt, self-review, revise,
// approve, provenance, vault write); splitting it mid-feature would separate
// tightly coupled steps the M1/M2-tuned draft flow relies on.
// Safety ceiling, not a work-limiting cap: large enough to hold a full case +
// readings as full text. The real guard against a pathological giant file
// (e.g. a 13MB CSV) is the per-file budget skip in retrieve.ts, not this number.
const draftContextBudget = 128_000

type AiPolicy = "allowed" | "prohibited"
type AssignmentCourse = {
  readonly code: string
  readonly canvasId: string
  readonly canvasUrl: string
  readonly aiPolicy?: AiPolicy
}
type AssignmentArtifact = {
  readonly canvasId: string
  readonly title: string
  readonly canvasUrl: string
  readonly dueAt?: string | null
  readonly groupCategoryId?: string | number | null
}
type AssignmentContextInput = {
  readonly vaultRoot: string
  readonly config: SchoolConfig
  readonly course: AssignmentCourse
  readonly assignment: AssignmentArtifact
  readonly triage: TriageFunction
}
export type DraftAssignmentInput = AssignmentContextInput & {
  readonly runner: AgentRunner
  readonly index: SchoolIndex
}
export type DiscussAssignmentInput = AssignmentContextInput & {
  readonly runner: AgentRunner
  readonly message: string
}
export type ReviseAssignmentInput = {
  readonly vaultRoot: string
  readonly config: SchoolConfig
  readonly runner: AgentRunner
  readonly runId: string
  readonly feedback: string
  readonly triage: TriageFunction
  readonly index: SchoolIndex
}
export type ApproveAssignmentInput = {
  readonly vaultRoot: string
  readonly config: SchoolConfig
  readonly runner: AgentRunner
  readonly runId: string
}
export type AssignmentDraftResult = {
  readonly path: string
  readonly runId: string
  readonly status: "pending_approval"
  readonly version: number
}
export type AssignmentDiscussionResult = { readonly path: string; readonly runId: string }
export type AssignmentApprovalResult = { readonly path: string; readonly runId: string }

export class AssignmentGenerationError extends Error {
  readonly name = "AssignmentGenerationError"

  constructor(readonly detail: string) {
    super(`Assignment generation failed: ${detail}`)
  }
}

type ResolvedCourse = AssignmentCourse & { readonly aiPolicy: AiPolicy }
type LocatedDraft = { readonly path: string; readonly provenance: AssignmentProvenance }

export function groupCategoryFromContent(content: string): string | null {
  return /^Group category: (.+)$/m.exec(content)?.[1] ?? null
}

export type ExternalSourceReference = { readonly url: string; readonly text: string }

const anchorPattern = /<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis
const bareUrlPattern = /https?:\/\/[^\s"'<>)]+/g
// Some email link protection services wrap external links as
// `.../v3/__<real-url>__;<garbage>`; unwrap these so the surfaced list names
// the original host, not the forwarding wrapper.
const urldefenseWrap = /urldefense\.com\/v\d+\/__(https?:\/\/[^_]+)__/i

/**
 * External (non-Canvas) links referenced by an assignment's own description,
 * e.g. an external exhibit-data link the vault never syncs. Used to
 * banner the draft prompt with sources the model must not fabricate around.
 * Canvas `/files/<id>` links are handled separately by sync — not surfaced here.
 */
export function externalSourceReferences(
  content: string,
  canvasBaseUrl: string,
): readonly ExternalSourceReference[] {
  const seen = new Set<string>()
  const refs: ExternalSourceReference[] = []
  const add = (rawUrl: string, text: string): void => {
    const url = urldefenseWrap.exec(rawUrl)?.[1] ?? rawUrl
    if (seen.has(url) || !isExternalHost(url, canvasBaseUrl)) {
      return
    }
    seen.add(url)
    refs.push({ url, text: text.trim() })
  }
  for (const match of content.matchAll(anchorPattern)) {
    const href = match[1]
    if (href !== undefined) {
      add(href, (match[2] ?? "").replace(/<[^>]+>/g, ""))
    }
  }
  for (const match of content.matchAll(bareUrlPattern)) {
    add(match[0], "")
  }
  return refs
}

function isExternalHost(url: string, canvasBaseUrl: string): boolean {
  try {
    return new URL(url).host !== new URL(canvasBaseUrl).host
  } catch {
    return false
  }
}

export async function draftAssignment(input: DraftAssignmentInput): Promise<AssignmentDraftResult> {
  assertUnderSpendCap({
    index: input.index,
    cap: input.config.cost.maxMonthlySpendUSD,
    now: new Date(),
  })
  const course = await resolveCoursePolicy(input.vaultRoot, input.config, input.course)
  const context = await assignmentContext({ ...input, course })
  const requirements = await resolveRequirements({
    vaultRoot: input.vaultRoot,
    courseCode: course.code,
    courseCanvasId: course.canvasId,
    defaultSections: [],
    sources: context.deliverableSources,
    scope: context.scope,
    guidanceContent: context.guidance,
  })
  const prompt = draftPrompt(
    course,
    input.assignment,
    context.content,
    requirements,
    context.externalSources,
  )
  const generated = await generateGatedDraft(() => input.runner.run(prompt))
  const computations = extractComputations(await input.runner.get(generated.runId))
  const reviewed = await selfReviewDraft(input.runner, {
    courseCode: course.code,
    assignmentTitle: input.assignment.title,
    assignmentUrl: input.assignment.canvasUrl,
    draft: generated.text,
    context: context.content,
    computations,
  })
  logAssignmentUsage({
    index: input.index,
    config: input.config,
    runId: generated.runId,
    context: context.content,
    draftText: generated.text,
    draftUsage: generated.usage,
    reviewUsage: reviewed.usage,
  })
  return writeDraft({
    vaultRoot: input.vaultRoot,
    config: input.config,
    course,
    assignment: input.assignment,
    sourceFiles: context.sourceFiles,
    runId: generated.runId,
    text: withCorrectnessCheck(generated.text, reviewed.note),
  })
}

export async function reviseAssignment(
  input: ReviseAssignmentInput,
): Promise<AssignmentDraftResult> {
  assertUnderSpendCap({
    index: input.index,
    cap: input.config.cost.maxMonthlySpendUSD,
    now: new Date(),
  })
  const located = await findDraft(input.vaultRoot, input.runId)
  const course = await resolveCoursePolicy(input.vaultRoot, input.config, {
    code: located.provenance.course.code,
    canvasId: located.provenance.course.canvas_id,
    canvasUrl: located.provenance.course.canvas_url,
    aiPolicy: located.provenance.ai_policy,
  })
  const assignment = assignmentFrom(located.provenance)
  const prior = await input.runner.get(input.runId)
  if (prior.resultText === null) {
    throw new AssignmentGenerationError("the gated run has no prior draft text")
  }
  // Hoist to a narrowed local: the retry closure below re-widens `prior.resultText`.
  const priorText = prior.resultText
  const current = withoutAssignmentProvenance(
    parseVaultDocument(await readFile(located.path, "utf8"), located.path).content,
  ).replace("> **Group assignment:** this draft is YOUR contribution.\n\n", "")
  const context = await assignmentContext({ ...input, course, assignment })
  const requirements = await resolveRequirements({
    vaultRoot: input.vaultRoot,
    courseCode: course.code,
    courseCanvasId: course.canvasId,
    defaultSections: [],
    sources: context.deliverableSources,
    scope: context.scope,
    guidanceContent: context.guidance,
  })
  const generated = await generateGatedDraft(() =>
    input.runner.revise(
      input.runId,
      revisePrompt(
        priorText,
        current,
        input.feedback,
        context.content,
        requirements,
        context.externalSources,
      ),
    ),
  )
  const computations = extractComputations(await input.runner.get(generated.runId))
  const reviewed = await selfReviewDraft(input.runner, {
    courseCode: course.code,
    assignmentTitle: assignment.title,
    assignmentUrl: assignment.canvasUrl,
    draft: generated.text,
    context: context.content,
    computations,
  })
  logAssignmentUsage({
    index: input.index,
    config: input.config,
    runId: generated.runId,
    context: context.content,
    draftText: generated.text,
    draftUsage: generated.usage,
    reviewUsage: reviewed.usage,
  })
  return writeDraft({
    vaultRoot: input.vaultRoot,
    config: input.config,
    course,
    assignment,
    sourceFiles: context.sourceFiles,
    runId: generated.runId,
    text: withCorrectnessCheck(generated.text, reviewed.note),
  })
}

export async function discussAssignment(
  input: DiscussAssignmentInput,
): Promise<AssignmentDiscussionResult> {
  const course = await resolveCoursePolicy(input.vaultRoot, input.config, input.course)
  const context = await assignmentContext({ ...input, course })
  const result = await input.runner.run(
    [
      `Discuss the ${input.assignment.title} assignment for ${course.code}.`,
      "Do not draft or submit an artifact; answer the student's question only.",
      input.message,
      context.content,
    ].join("\n\n"),
  )
  if (result.text === null) {
    throw new AssignmentGenerationError("the discussion agent returned no response")
  }
  const paths = coursePaths(input.vaultRoot, course.code, course.canvasId)
  const slug = assignmentSlug(input.assignment)
  const drafts = assignmentPaths(paths, {
    title: input.assignment.title,
    ...(input.assignment.dueAt === undefined ? {} : { dueAt: input.assignment.dueAt }),
  }).drafts
  const path = join(drafts, `${slug}.discuss.md`)
  await mkdir(drafts, { recursive: true })
  await appendFile(
    path,
    `## ${new Date().toISOString()}\n\n${input.message}\n\n${result.text.trim()}\n\n`,
    "utf8",
  )
  return { path, runId: result.runId }
}

export async function approveAssignment(
  input: ApproveAssignmentInput,
): Promise<AssignmentApprovalResult> {
  const located = await findDraft(input.vaultRoot, input.runId)
  const course = await resolveCoursePolicy(input.vaultRoot, input.config, {
    code: located.provenance.course.code,
    canvasId: located.provenance.course.canvas_id,
    canvasUrl: located.provenance.course.canvas_url,
    aiPolicy: located.provenance.ai_policy,
  })
  // A draft that emitted its text without parking at the gate is already
  // "completed" — there is nothing to resolve on the runner, so promote it as
  // is. Only a genuinely parked (pending_approval) run is approved through the
  // runner. Without this, `approve` fails on every draft a model completes
  // directly (which is how these models behave), never reaching `final/`.
  const existing = await input.runner.get(input.runId)
  if (existing.status === "pending_approval") {
    const approved = await input.runner.approve(input.runId)
    if (approved.status !== "completed") {
      throw new AssignmentGenerationError("approval did not complete the gated run")
    }
  }
  const assignment = assignmentFrom(located.provenance)
  const draftBody = parseVaultDocument(await readFile(located.path, "utf8"), located.path).content
  const content = extractSubmissionContent(draftBody)
  const result = await new VaultWriter({
    root: input.vaultRoot,
    gitInit: input.config.vault.gitInit,
  }).write({
    course,
    kind: vaultDocumentKinds.final,
    title: assignment.title,
    canvasId: assignment.canvasId,
    canvasUrl: assignment.canvasUrl,
    content,
    assignment: {
      title: assignment.title,
      ...(assignment.dueAt === undefined ? {} : { dueAt: assignment.dueAt }),
    },
    source: vaultSources.agent,
    status: vaultStatuses.final,
    model: located.provenance.model_ids.draft,
  })
  return { path: result.path, runId: input.runId }
}

async function assignmentContext(
  input: Omit<AssignmentContextInput, "course"> & { readonly course: ResolvedCourse },
): Promise<{
  readonly content: string
  readonly guidance: string
  readonly sourceFiles: readonly string[]
  readonly externalSources: readonly ExternalSourceReference[]
  readonly deliverableSources: readonly DeliverableSource[]
  readonly scope: string | undefined
}> {
  const paths = coursePaths(input.vaultRoot, input.course.code, input.course.canvasId)
  const slug = assignmentSlug(input.assignment)
  const guidancePath = courseDocumentPath(paths, {
    kind: vaultDocumentKinds.guidance,
    title: `${slug}-guidance`,
    canvasId: input.assignment.canvasId,
  })
  await new VaultWriter({ root: input.vaultRoot, gitInit: input.config.vault.gitInit }).write({
    course: input.course,
    kind: vaultDocumentKinds.guidance,
    title: `${slug}-guidance`,
    canvasId: input.assignment.canvasId,
    canvasUrl: input.assignment.canvasUrl,
    content: "# Assignment guidance\n\nAdd your goals, constraints, and preferred voice here.",
    source: vaultSources.user,
    status: vaultStatuses.final,
  })
  const guidance = parseVaultDocument(await readFile(guidancePath, "utf8"), guidancePath).content
  const assignmentDoc = await readAssignmentDoc(paths, input)
  const priorityPaths = await assignmentLinkedFilePaths(paths, assignmentDoc)
  const externalSources =
    assignmentDoc === null
      ? []
      : externalSourceReferences(assignmentDoc, input.config.canvas.baseUrl)
  const selection = await selectModulesForAssignment(paths.root, {
    canvasId: input.assignment.canvasId,
    title: input.assignment.title,
  })
  const assembled = await assembleCourseContext({
    vaultRoot: input.vaultRoot,
    course: { code: input.course.code, canvasId: input.course.canvasId },
    task: `assignment ${input.assignment.title} ${slug}`,
    runId: randomUUID(),
    functionName: "assignmentDraft",
    config: input.config,
    tokenBudget: draftContextBudget,
    triage: input.triage,
    priorityPaths,
    selection,
  })
  const guidanceRelativePath = relative(paths.root, guidancePath)
  const deliverableSources: DeliverableSource[] = [
    ...(assignmentDoc === null ? [] : [{ path: "assignment-description", text: assignmentDoc }]),
    ...assembled.selectedTexts.map((entry) => ({ path: entry.path, text: entry.text })),
  ]
  return {
    content: assembled.context,
    guidance,
    sourceFiles: [
      ...new Set([...assembled.sources.map((source) => source.path), guidanceRelativePath]),
    ],
    externalSources,
    deliverableSources,
    scope: assignmentDoc === null ? undefined : extractPartScope(assignmentDoc),
  }
}

// A "PART I" / "Part A" / "Part 2" mention in the assignment's own
// description, when a case file carries multiple sessions' deliverables so
// detection must be scoped to only the part this assignment covers.
const partScopePattern = /\bpart\s+([ivxlcdm]+|[a-z]|\d+)\b/i

export function extractPartScope(text: string): string | undefined {
  const match = partScopePattern.exec(text)
  return match === null ? undefined : `PART ${(match[1] ?? "").toUpperCase()}`
}

// Reads the assignment's own synced description, if any. Never throws: any
// read failure (not yet synced, missing file) yields null so callers degrade
// gracefully to "no priority files" / "no external sources".
async function readAssignmentDoc(
  paths: ReturnType<typeof coursePaths>,
  input: Omit<AssignmentContextInput, "course"> & { readonly course: ResolvedCourse },
): Promise<string | null> {
  try {
    const compatibilityPath = join(paths.assignments, `${assignmentSlug(input.assignment)}.md`)
    const compatibility = await readOptional(compatibilityPath)
    if (compatibility !== null) {
      return parseVaultDocument(compatibility, compatibilityPath).content
    }
    const assignmentDocPath = await findCourseDocument(
      paths.root,
      vaultDocumentKinds.assignment,
      input.assignment.canvasId,
    )
    if (assignmentDocPath === null) return null
    return parseVaultDocument(await readFile(assignmentDocPath, "utf8"), assignmentDocPath).content
  } catch {
    return null
  }
}

// Vault paths for the files the assignment's own description links to (e.g.
// the case PDF + questions PDF), so retrieval can prioritize them ahead of
// keyword-matched noise. Never throws: any read failure yields no priority.
async function assignmentLinkedFilePaths(
  paths: ReturnType<typeof coursePaths>,
  assignmentDoc: string | null,
): Promise<readonly string[]> {
  try {
    if (assignmentDoc === null) {
      return []
    }
    const linkedIds = new Set(fileIdsFromHtml(assignmentDoc))
    if (linkedIds.size === 0) {
      return []
    }
    const byCanvasId = new Map<string, string>()
    for (const filePath of await markdownFiles(paths.root)) {
      try {
        const parsed = parseVaultDocument(await readFile(filePath, "utf8"), filePath)
        if (linkedIds.has(String(parsed.frontmatter.canvas_id))) {
          byCanvasId.set(String(parsed.frontmatter.canvas_id), relative(paths.root, filePath))
        }
      } catch {}
    }
    return [...linkedIds].flatMap((id) => {
      const path = byCanvasId.get(id)
      return path === undefined ? [] : [path]
    })
  } catch {
    return []
  }
}

/**
 * Log one `assignmentDraft` usage row per draft/revision call, combining the
 * draft generation and its self-review (a second, ungated model call — see
 * `assignment-review.ts`) into a single row keyed by the run id: both calls
 * are one submittable-deliverable flow, so their token counts are summed
 * before the single upsert rather than letting the review's call silently
 * replace the draft's (the token_usage PK is (run id, model, function_name),
 * so a naive second write to the same key would overwrite, not accumulate).
 * Falls back to `estimateTokens` only when the SDK reported no usage at all
 * for a leg (e.g. the review failed before any model call completed).
 */
function logAssignmentUsage(input: {
  readonly index: SchoolIndex
  readonly config: SchoolConfig
  readonly runId: string
  readonly context: string
  readonly draftText: string
  readonly draftUsage: AgentRunResult["usage"]
  readonly reviewUsage: AgentRunResult["usage"]
}): void {
  const draftInput = input.draftUsage?.inputTokens ?? estimateTokens(input.context)
  const draftOutput = input.draftUsage?.outputTokens ?? estimateTokens(input.draftText)
  const reviewInput = input.reviewUsage?.inputTokens ?? 0
  const reviewOutput = input.reviewUsage?.outputTokens ?? 0
  const cachedInputTokens =
    (input.draftUsage?.cachedInputTokens ?? 0) + (input.reviewUsage?.cachedInputTokens ?? 0)
  recordModelUsage({
    index: input.index,
    model: input.config.models.functions.assignmentDraft,
    functionName: "assignmentDraft",
    runId: input.runId,
    recordedAt: new Date().toISOString(),
    usage: {
      inputTokens: draftInput + reviewInput,
      outputTokens: draftOutput + reviewOutput,
      cachedInputTokens,
      // The draft call is the primary submittable-deliverable generation;
      // its generation id is what a reconcile lookup should key on. Falls
      // back to the review's only if the draft call reported none.
      generationId: input.draftUsage?.generationId ?? input.reviewUsage?.generationId ?? null,
    },
  })
}

async function writeDraft(input: {
  readonly vaultRoot: string
  readonly config: SchoolConfig
  readonly course: ResolvedCourse
  readonly assignment: AssignmentArtifact
  readonly sourceFiles: readonly string[]
  readonly runId: string
  readonly text: string
}): Promise<AssignmentDraftResult> {
  const paths = coursePaths(input.vaultRoot, input.course.code, input.course.canvasId)
  const drafts = assignmentPaths(paths, {
    title: input.assignment.title,
    ...(input.assignment.dueAt === undefined ? {} : { dueAt: input.assignment.dueAt }),
  }).drafts
  const version = await draftVersion(drafts, input.assignment)
  const provenance = assignmentProvenanceSchema.parse({
    course: {
      code: input.course.code,
      canvas_id: input.course.canvasId,
      canvas_url: input.course.canvasUrl,
    },
    assignment: {
      canvas_id: input.assignment.canvasId,
      title: input.assignment.title,
      slug: assignmentSlug(input.assignment),
      canvas_url: input.assignment.canvasUrl,
      due_at: input.assignment.dueAt ?? null,
      group_category_id:
        input.assignment.groupCategoryId === null || input.assignment.groupCategoryId === undefined
          ? null
          : String(input.assignment.groupCategoryId),
    },
    ai_policy: input.course.aiPolicy,
    model_ids: {
      draft: input.config.models.functions.assignmentDraft,
      discuss: input.config.models.functions.assignmentDiscuss,
    },
    source_files: input.sourceFiles,
    timestamp: new Date().toISOString(),
    version,
    run_id: input.runId,
  })
  const content = [
    renderAssignmentProvenance(provenance),
    provenance.assignment.group_category_id === null
      ? ""
      : "> **Group assignment:** this draft is YOUR contribution.",
    input.text.trim(),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n")
  parseAssignmentProvenance(content)
  const result = await new VaultWriter({
    root: input.vaultRoot,
    gitInit: input.config.vault.gitInit,
  }).write({
    course: input.course,
    kind: vaultDocumentKinds.draft,
    title: input.assignment.title,
    canvasId: input.assignment.canvasId,
    canvasUrl: input.assignment.canvasUrl,
    content,
    assignment: {
      title: input.assignment.title,
      ...(input.assignment.dueAt === undefined ? {} : { dueAt: input.assignment.dueAt }),
    },
    source: vaultSources.agent,
    status: vaultStatuses.draft,
    model: input.config.models.functions.assignmentDraft,
  })
  await writeDraftWorkbook(result.path, input.text)
  return { path: result.path, runId: input.runId, status: "pending_approval", version }
}

// A computational deliverable's tabular results (T-accounts, schedules, …)
// are rendered as Markdown tables in the draft (see `tabularOutputDirective`)
// specifically so they can be lifted, verbatim, into a real spreadsheet next
// to the draft — "correct content, wrong container" otherwise: a student
// cannot paste ASCII art into a workbook. Writes nothing when the draft has
// no tables and no `## Computations` section (e.g. a discussion-style draft).
async function writeDraftWorkbook(draftPath: string, text: string): Promise<void> {
  const sheets = sheetsFromDraft(text)
  if (sheets.length === 0) {
    return
  }
  await writeFile(xlsxSiblingPath(draftPath), await buildXlsx(sheets))
}

// Fired at every draft and revision: forbids filling a data gap from the
// model's memory, and instead requires the model to raise it to the human.
// See ADR: fabricated exhibit figures (e.g. unsupported overhead numbers)
// silently poisoned every downstream calculation when the model guessed at
// data behind an external (non-vault) link instead of flagging it missing.
function noFabricationDirective(externalSources: readonly ExternalSourceReference[]): string {
  const banner =
    "Ground every quantitative claim in the provided Materials. Do NOT invent or recall from " +
    "memory any figures, exhibit values, dataset numbers, or table data that are not present " +
    "in the Materials. If a required number or dataset is NOT in the Materials: (a) add it to " +
    "a `## Missing required sources` section at the TOP of your answer, naming exactly what " +
    "you need and where the assignment references it (e.g. the external link(s) below), and " +
    "(b) for each answer that depends on that missing data, write `PENDING — requires <source>` " +
    "instead of a fabricated value. Complete fully only the parts you can ground in the Materials."
  if (externalSources.length === 0) {
    return banner
  }
  const list = externalSources
    .map((ref) => (ref.text.length === 0 ? `- ${ref.url}` : `- ${ref.url} ("${ref.text}")`))
    .join("\n")
  return `${banner}\n\nReferenced sources NOT available to you (must be provided by the user):\n${list}`
}

// Companion to `noFabricationDirective`: that directive governs SOURCE data
// missing from the Materials; this one governs DERIVED numbers computed from
// data that IS present. A model computing a margin or NPV "in its head" is
// how prior numerical errors happened even with real source figures
// in context — the fix is a real calculator, not another warning alone.
//
// BATCHING (call count) and REPORTING (the `## Computations` section) are
// deliberately decoupled: a live draft batched 17 derived values into ONE
// `calculate` call labelled `rs_part1_accounting_calculations`, then
// collapsed all 17 into a single `## Computations` line because the section
// mirrored the call, not the values — leaving `xlsx-extract.ts` unable to
// pull more than one row out of it. Batch the CALLS; never batch the LINES.
const calculationDirective =
  "Every derived quantitative value — a rate, total, margin, NPV, ratio, or any figure computed " +
  "from source figures — MUST be produced by the `calculate` tool, using the source figures from " +
  "the Materials as literals in `code`. Never compute a derived number by hand or from memory; a " +
  "source figure quoted verbatim from the Materials does not need a `calculate` call. " +
  "BATCH your work: a single `calculate` call can compute MANY values at once — put the arithmetic " +
  "for a whole part (or the entire draft) in one `code` script that `console.log`s each result as " +
  "`label: value`. Use the fewest calls that cover the work (ideally one to three total); do NOT " +
  "make a separate call per number — that is slow and unnecessary. Regardless of how many values " +
  "one `calculate` call produced, end the draft with a `## Computations` section that UNROLLS every " +
  "one of them into its OWN line — never one line summarizing or listing several values together. " +
  "A call that logged 17 `label: value` pairs means the `## Computations` section has 17 lines, " +
  "each in the exact format `- label — value` (one label, one value, on that one line)."

// Companion to `calculationDirective`: a computational deliverable's tabular
// results (T-accounts, schedules, trial balances, …) must come out as real,
// SPREADSHEET-SHAPED Markdown tables — not ASCII art in a code fence (which
// can't be parsed) and not prose mashed into a cell. A live draft produced
// cells like `(1) Stock Issuance: $26.00` and `**Ending Balance: $30.40**`:
// the number was trapped inside a sentence with a bold marker and an index
// prefix, so `xlsx-extract.ts` (which lifts these tables into the
// accompanying spreadsheet — see `writeDraftWorkbook`) recognized the table
// but produced zero numeric cells. This directive exists to prevent that.
//
// The per-table-heading requirement below exists because THREE separate
// extraction-side heuristics for naming a table's spreadsheet tab — a
// distinctive header word, then also reading the first data row — each
// mis-fired on live drafts (grabbing a row label like "Beg", a transaction
// description, or a misclassified bare number) once a model grouped many
// T-accounts under one shared `#### Assets` heading. Guessing a name from
// cell contents cannot be made reliable; the document has to carry its own
// label instead. `xlsx-extract.ts` now reads the heading immediately above
// each table as that table's sheet name, so the model supplying exactly one
// heading per table is load-bearing, not cosmetic (though it also makes the
// draft materially more readable on its own).
function tabularOutputDirective(deliverable: Deliverable): string {
  if (deliverable.kind !== "requirements") {
    return ""
  }
  return (
    "Render every tabular result (T-accounts, ledgers, schedules, trial balances, statements) " +
    "as a GitHub-flavored Markdown table: a pipe-delimited header row, a `---` separator row, " +
    "then one pipe-delimited data row per line. Never render a table as ASCII art inside a code " +
    "fence — it will not be usable. Give EVERY table its own Markdown heading immediately above " +
    "it, naming exactly what that table is (the account or statement, e.g. `#### Cash`, `#### " +
    "Accounts Receivable`, `#### Prepaid Lease`, `#### Income Statement`) — never group several " +
    "tables under one shared heading (e.g. one `#### Assets` heading over several T-accounts): " +
    "one table, one heading, and the heading names the specific account/statement, not a broad " +
    "category. Shape every table so it is actually a SPREADSHEET, not prose in a grid: put " +
    "exactly ONE value per cell. A numeric cell contains ONLY the bare number — no `$`, no `%`, " +
    "no thousands commas, no `**bold**` markers, no leading index like `(1)`, no trailing words " +
    "or units — put the currency symbol, the index, the description, and any label in their OWN " +
    "separate column instead (e.g. a T-account row is `Ref | Description | Debit | Credit`, with " +
    "a bare `26.00` alone in the Debit cell, never `(1) Stock Issuance: $26.00` combined into one " +
    "cell). Do not bold any cell's contents. This is in addition to, not instead of, the `## " +
    "Computations` section: the same numbers appear in both places."
  )
}

function deliverableRequirement(deliverable: Deliverable): string {
  if (deliverable.kind === "none") {
    return ""
  }
  const framing = deliverableFraming(deliverable, {
    questions: "answer each discussion question below",
    requirements: "satisfy each required item below",
  })
  const items = formatDeliverableItems(deliverable)
  return [
    `The assignment (via "${deliverable.cue}" in ${deliverable.sourcePath}) requires you to ${framing}, each fully answered from the sources — never merely restated. Give each item its own clearly-labelled section (copy the heading verbatim).`,
    items,
  ].join("\n\n")
}

function draftPrompt(
  course: ResolvedCourse,
  assignment: AssignmentArtifact,
  context: string,
  requirements: ArtifactRequirements,
  externalSources: readonly ExternalSourceReference[],
): string {
  const groupNote =
    assignment.groupCategoryId === null || assignment.groupCategoryId === undefined
      ? ""
      : "This is a group assignment: draft only the student's contribution."
  const structureDirective = requirements.sectionsDeclared
    ? `Structure the draft around exactly these sections, in this order, each as an H2 heading: ${requirements.sections.join(", ")}.`
    : ""
  return [
    `Complete this ${course.code} assignment and produce the actual deliverable: ${assignment.title}.`,
    groupNote,
    "Do the work, do not describe it: answer every question the assignment asks and finish every required part to submittable quality — the answered problem set, the finished analysis, the complete writeup — using the supplied source material and data. State the actual answers with the numbers, quotes, and evidence from the sources; never deliver a guide, an outline, or a plan about the topic. Do not claim Canvas submission or write to Canvas.",
    noFabricationDirective(externalSources),
    calculationDirective,
    tabularOutputDirective(requirements.deliverable),
    structureDirective,
    deliverableRequirement(requirements.deliverable),
    "Write the COMPLETE draft as the Markdown body of your answer; that text IS the deliverable. Do not wrap it in a tool call.",
    'Then call the configured approval-gate tool with the short marker "ready". The tool call is only a pause signal — never pass draft content inside it.',
    `## Student guidance\n${requirements.instructions}`,
    context,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n")
}

function revisePrompt(
  previous: string,
  current: string,
  feedback: string,
  context: string,
  requirements: ArtifactRequirements,
  externalSources: readonly ExternalSourceReference[],
): string {
  return [
    "Revise the gated assignment draft. Preserve and incorporate both the student's hand edits and feedback.",
    noFabricationDirective(externalSources),
    calculationDirective,
    tabularOutputDirective(requirements.deliverable),
    deliverableRequirement(requirements.deliverable),
    `## Student edit diff\n${lineDiff(previous, current)}`,
    `## Student feedback\n${feedback}`,
    'Return the complete revised Markdown artifact as the body of your answer, then call the approval-gate tool with the short marker "ready"; never put the artifact inside the tool call.',
    context,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n")
}

function requireGatedDraft(result: AgentRunResult): {
  readonly runId: string
  readonly text: string
  readonly usage: AgentRunResult["usage"]
} {
  // The artifact is the agent text; writeDraft still marks it gated, so a model
  // that emits text without parking at the gate is accepted (M1 replay never requests approval).
  if (result.text === null) {
    throw new AssignmentGenerationError("the draft agent did not return text for the draft")
  }
  return { runId: result.runId, text: result.text.trim(), usage: result.usage }
}

// Flash models intermittently end a turn with only a tool call and no draft
// text. One retry turns that transient miss into a draft instead of a hard
// failure — observed on both the revise turn and a live draft during the M2
// dogfood, on the same assignment that succeeds on a re-run.
async function generateGatedDraft(
  generate: () => Promise<AgentRunResult>,
): Promise<ReturnType<typeof requireGatedDraft>> {
  const first = await generate()
  return requireGatedDraft(first.text === null ? await generate() : first)
}

/**
 * Resolves the ai_policy value to record in a draft's provenance header.
 * Drafting itself is never refused on this value; it is disclosure metadata,
 * this only determines what gets disclosed alongside the generated draft.
 */
async function resolveCoursePolicy(
  vaultRoot: string,
  config: SchoolConfig,
  course: AssignmentCourse,
): Promise<ResolvedCourse> {
  const indexPath = coursePaths(vaultRoot, course.code, course.canvasId).index
  const index = await readOptional(indexPath)
  const aiPolicy =
    index === null
      ? (course.aiPolicy ?? config.aiPolicyDefault)
      : parseVaultDocument(index, indexPath).frontmatter.ai_policy
  return { ...course, aiPolicy }
}

async function findDraft(vaultRoot: string, runId: string): Promise<LocatedDraft> {
  const courses = await readdir(vaultRoot, { withFileTypes: true })
  const candidates: LocatedDraft[] = []
  for (const course of courses) {
    if (!course.isDirectory() || course.name.startsWith(".")) {
      continue
    }
    for (const path of await markdownFiles(join(vaultRoot, course.name))) {
      if (path.endsWith(".discuss.md")) continue
      try {
        const parsed = parseVaultDocument(await readFile(path, "utf8"), path)
        if (parsed.frontmatter.type !== vaultDocumentKinds.draft) continue
        const provenance = parseAssignmentProvenance(parsed.content)
        if (provenance.run_id === runId) candidates.push({ path, provenance })
      } catch {
        // Non-draft Markdown and hand-authored notes are irrelevant here.
      }
    }
  }
  candidates.sort((left, right) => right.provenance.version - left.provenance.version)
  const latest = candidates[0]
  if (latest === undefined) {
    throw new AssignmentGenerationError(`no draft is associated with run ${runId}`)
  }
  return latest
}

async function draftVersion(directory: string, assignment: AssignmentArtifact): Promise<number> {
  const entries = await readDirectory(directory)
  const base = humanPathSegment(assignment.title, `Untitled ${vaultDocumentKinds.draft}`)
  const hasBase = entries.some((entry) => entry.name === `${base}.md`)
  if (!hasBase) {
    return 1
  }
  const versions = entries.flatMap((entry) => {
    const match = new RegExp(`^${escapeRegExp(base)}\\.v(\\d+)\\.md$`).exec(entry.name)
    return match === null ? [] : [Number.parseInt(match[1] ?? "0", 10)]
  })
  return Math.max(1, ...versions) + 1
}

function assignmentFrom(provenance: AssignmentProvenance): AssignmentArtifact {
  return {
    canvasId: provenance.assignment.canvas_id,
    title: provenance.assignment.title,
    canvasUrl: provenance.assignment.canvas_url,
    dueAt: provenance.assignment.due_at ?? null,
    groupCategoryId: provenance.assignment.group_category_id,
  }
}

async function findCourseDocument(
  courseRoot: string,
  kind: string,
  canvasId: string,
): Promise<string | null> {
  for (const path of await markdownFiles(courseRoot)) {
    try {
      const parsed = parseVaultDocument(await readFile(path, "utf8"), path)
      if (parsed.frontmatter.type === kind && parsed.frontmatter.canvas_id === String(canvasId)) {
        return path
      }
    } catch {
      // Ignore generated navigation and hand-authored Markdown without vault frontmatter.
    }
  }
  return null
}

async function markdownFiles(directory: string): Promise<readonly string[]> {
  const entries = await readDirectory(directory)
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return markdownFiles(path)
      return Promise.resolve(entry.isFile() && entry.name.endsWith(".md") ? [path] : [])
    }),
  )
  return nested.flat()
}

function assignmentSlug(assignment: AssignmentArtifact): string {
  return slugify(assignment.title, `untitled-${assignment.canvasId}`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
