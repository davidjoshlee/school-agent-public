// allow: SIZE_OK — assembleCourseContext owns the whole budget-aware selection
// pipeline (priority-file admission with summary fallback, keyword selection,
// fixed sources, truncation, context logging); splitting it would fragment a
// single accounting invariant (selectionBudget/budgetUsed) across files.
import { appendFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import type { SchoolConfig } from "../config/index.js"
import { modelMappings } from "../models/index.js"
import { coursePaths, vaultPaths } from "../store/paths.js"
import {
  parseManifest,
  readVaultText,
  type SummaryRequest,
  selectEntries,
  summaryFor,
  type VaultText,
  vaultRelativePath,
} from "./retrieve-files.js"
import type { ModuleSelection } from "./retrieve-selection.js"

const largeFileTokenEstimate = 200
const manifestTier = "manifest" as const
const summaryTier = "summary" as const
const fullTextTier = "full-text" as const

export type ContextSource = {
  readonly path: string
  readonly tier: typeof manifestTier | typeof summaryTier | typeof fullTextTier
}

export type TriageFunction = {
  summarize(input: SummaryRequest): Promise<string>
}

export type AssembleCourseContextInput = {
  readonly vaultRoot: string
  readonly course: { readonly code: string; readonly canvasId: string | number }
  readonly task: string
  readonly runId: string
  readonly functionName: keyof SchoolConfig["models"]["functions"]
  readonly config: SchoolConfig
  readonly tokenBudget: number
  readonly triage: TriageFunction
  readonly priorityPaths?: readonly string[]
  /**
   * Module-structured selection from retrieve-selection.ts. `{ mode:
   * "module" }` replaces the keyword pass entirely with its resolved paths
   * (admitted the same way priorityPaths are: full text first, summary
   * fallback when oversized). `{ mode: "keyword-fallback" }` and `undefined`
   * both run the existing keyword pass — the distinction is only what gets
   * logged as `selectionMode` in the context log, so a caller that tried
   * module selection and found nothing stays visible as degraded rather
   * than indistinguishable from a caller that never tried.
   */
  readonly selection?: ModuleSelection
}

export type AssembledCourseContext = {
  readonly context: string
  readonly estimatedTokens: number
  readonly selected: readonly string[]
  readonly sources: readonly ContextSource[]
  /**
   * The selected full-text/summary documents' own path + content, in
   * selection-priority order (priority/module paths first, then keyword
   * matches). Lets a caller (e.g. deliverable detection) reuse the exact
   * text already read for context assembly instead of re-reading the vault.
   */
  readonly selectedTexts: readonly { readonly path: string; readonly text: string }[]
}

type FixedSource = {
  readonly label: string
  readonly path: string
  readonly source: VaultText | null
}

class RetrievalError extends Error {
  readonly name = "RetrievalError"
}

export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

function providerFor(model: string): string {
  return model.split("/", 1)[0] ?? "unknown"
}

function modelFor(
  config: SchoolConfig,
  functionName: keyof SchoolConfig["models"]["functions"],
): string {
  const mapping = modelMappings(config).find(
    (candidate) => candidate.key === `models.functions.${functionName}`,
  )
  if (mapping === undefined) {
    throw new RetrievalError(`No model registry entry for ${functionName}`)
  }
  return mapping.model
}

function isAllowed(restricted: boolean, config: SchoolConfig): boolean {
  return !restricted || config.restrictedFileHandling === "allow"
}

function truncateContext(context: string, tokenBudget: number): string {
  if (estimateTokens(context) <= tokenBudget) {
    return context
  }
  const note = `[Truncated to fit the ${tokenBudget}-token context budget]`
  const prefixLength = Math.max(0, tokenBudget * 4 - note.length - 1)
  return `${context.slice(0, prefixLength).trimEnd()}\n${note}`
}

async function appendContextLog(
  input: AssembleCourseContextInput,
  sources: readonly ContextSource[],
): Promise<void> {
  const model = modelFor(input.config, input.functionName)
  const contextLog = vaultPaths(input.vaultRoot).metadata.contextLog
  await mkdir(vaultPaths(input.vaultRoot).metadata.directory, { recursive: true })
  await appendFile(
    contextLog,
    `${JSON.stringify({
      runId: input.runId,
      function: input.functionName,
      provider: providerFor(model),
      model,
      sources,
      selectionMode: input.selection?.mode ?? "keyword",
      ...(input.selection?.mode === "module"
        ? {
            selectedModuleCanvasIds: input.selection.moduleCanvasIds,
            selectedModuleTitles: input.selection.moduleTitles,
          }
        : {}),
    })}\n`,
    "utf8",
  )
}

export async function assembleCourseContext(
  input: AssembleCourseContextInput,
): Promise<AssembledCourseContext> {
  const paths = coursePaths(input.vaultRoot, input.course.code, input.course.canvasId)
  const manifest = await readVaultText(paths.index)
  if (manifest === null) {
    throw new RetrievalError(`Course manifest is missing: ${paths.index}`)
  }
  const sources: ContextSource[] = [{ path: "_index.md", tier: manifestTier }]
  const selected: {
    path: string
    content: string
    tokenEstimate: number
    tier: typeof fullTextTier | typeof summaryTier
  }[] = []

  // Keep the fixed sources (syllabus/playbook/guidance) and formatting inside
  // the budget so the final assembly is not forced into the truncation fallback.
  const fixedContextReserve = Math.min(500, Math.floor(input.tokenBudget * 0.1))
  const selectionBudget = input.tokenBudget - fixedContextReserve
  let budgetUsed = 0
  const includedPaths = new Set<string>()

  // Priority files (e.g. the assignment's own linked case/questions files, or
  // a module-structured selection's resolved paths) are admitted before
  // keyword selection so they never lose the budget race to lower-relevance
  // matches. An oversized priority file still isn't skipped outright: its
  // summary sidecar is admitted instead, as a last resort.
  const priorityPaths = [
    ...(input.priorityPaths ?? []),
    ...(input.selection?.mode === "module" ? input.selection.paths : []),
  ]
  for (const priorityPath of priorityPaths) {
    const rel = vaultRelativePath(paths.root, priorityPath)
    if (includedPaths.has(rel)) {
      continue
    }
    const source = await readVaultText(resolve(paths.root, rel))
    if (source === null || !isAllowed(source.restricted, input.config)) {
      continue
    }
    includedPaths.add(rel)
    const estimate = estimateTokens(source.content)
    if (budgetUsed + estimate <= selectionBudget) {
      selected.push({
        path: rel,
        content: source.content,
        tokenEstimate: estimate,
        tier: fullTextTier,
      })
      budgetUsed += estimate
      continue
    }
    const summary = await summaryFor({
      entry: {
        title: rel,
        type: "file",
        dates: "",
        path: rel,
        tokenEstimate: estimate,
        restricted: false,
      },
      courseRoot: paths.root,
      model: modelFor(input.config, "extractSummary"),
      summarize: (request) => input.triage.summarize(request),
    })
    if (summary === null) {
      continue
    }
    const sumEstimate = estimateTokens(summary.content)
    if (budgetUsed + sumEstimate <= selectionBudget) {
      selected.push({
        path: summary.path,
        content: summary.content,
        tokenEstimate: sumEstimate,
        tier: summaryTier,
      })
      budgetUsed += sumEstimate
    }
  }

  // Module-structured selection replaces keyword scoring entirely: its
  // resolved paths were already admitted above as priority paths, so the
  // manifest keyword pass only runs when there is no module selection (or
  // it degraded to keyword-fallback) — otherwise unrelated same-course
  // matches (other assignments' forms, unrelated sessions' slides) would
  // leak back in via the generic task string.
  const keywordEntries =
    input.selection?.mode === "module"
      ? []
      : selectEntries(parseManifest(manifest.content), input.task)
  for (const entry of keywordEntries) {
    if (!isAllowed(entry.restricted, input.config)) {
      continue
    }
    const path = vaultRelativePath(paths.root, entry.path)
    if (includedPaths.has(path)) {
      continue
    }
    // Budget-aware selection: never read a file whose tokenEstimate would push
    // the accumulated context past the budget. Skipping (not breaking) keeps
    // smaller matches when an oversized top match would otherwise starve them.
    if (budgetUsed + entry.tokenEstimate > selectionBudget) {
      continue
    }
    const source = await readVaultText(resolve(paths.root, path))
    if (source === null || !isAllowed(entry.restricted || source.restricted, input.config)) {
      continue
    }
    includedPaths.add(path)
    budgetUsed += entry.tokenEstimate
    selected.push({
      path,
      content: source.content,
      tokenEstimate: entry.tokenEstimate,
      tier: fullTextTier,
    })
    if (entry.tokenEstimate >= largeFileTokenEstimate) {
      const summary = await summaryFor({
        entry,
        courseRoot: paths.root,
        model: modelFor(input.config, "extractSummary"),
        summarize: (request) => input.triage.summarize(request),
      })
      if (summary !== null) {
        sources.push({ path: summary.path, tier: summaryTier })
      }
    }
  }

  if (selected.length === 0) {
    const context =
      "No eligible context is available: every matching course artifact is restricted or absent."
    await appendContextLog(input, sources)
    return {
      context,
      estimatedTokens: estimateTokens(context),
      selected: [],
      sources,
      selectedTexts: [],
    }
  }

  sources.push(...selected.map(({ path, tier }) => ({ path, tier })))
  const fixed = await Promise.all([
    readVaultText(paths.syllabus),
    readVaultText(paths.playbook),
    readVaultText(resolve(paths.guidance, "prep-guidance.md")),
  ])
  const [syllabus, playbook, guidance] = fixed
  const fixedSources: readonly FixedSource[] = [
    { label: "Syllabus excerpt", path: "00-syllabus.md", source: syllabus },
    { label: "Course playbook", path: "_meta/course-playbook.md", source: playbook },
    { label: "Guidance", path: "guidance/prep-guidance.md", source: guidance },
  ] as const
  const usableFixed = fixedSources.filter(
    (item): item is FixedSource & { readonly source: VaultText } =>
      item.source !== null && isAllowed(item.source.restricted, input.config),
  )
  sources.push(...usableFixed.map((item) => ({ path: item.path, tier: fullTextTier })))

  const materials = selected.map((item) => `### ${item.path}\n${item.content}`).join("\n\n")
  const fixedText = usableFixed
    .map((item) => `## ${item.label}\n${item.source.content}`)
    .join("\n\n")
  const syllabusText =
    syllabus !== null && isAllowed(syllabus.restricted, input.config)
      ? `### Syllabus excerpt\n${syllabus.content}\n\n`
      : ""
  const context = ["## Materials", `${syllabusText}${materials}`, fixedText, "## Task", input.task]
    .filter((part) => part.length > 0)
    .join("\n\n")
  const boundedContext = truncateContext(context, input.tokenBudget)
  await appendContextLog(input, sources)
  return {
    context: boundedContext,
    estimatedTokens: estimateTokens(boundedContext),
    selected: selected.map((item) => item.path),
    sources,
    selectedTexts: selected.map((item) => ({ path: item.path, text: item.content })),
  }
}
