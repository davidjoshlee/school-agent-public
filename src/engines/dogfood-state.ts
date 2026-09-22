/**
 * Mutable state shared across the dogfood flows (populated as earlier flows
 * run) plus the lookup helpers every flow file needs. On a resumed run a
 * flow that already `pass`ed is skipped by the runner (dogfood.ts) and never
 * executes, so `hydrateDogfoodState` re-derives the same fields from the
 * persisted evidence strings before any flow runs — each flow's evidence
 * format is documented at its call site below.
 */

import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"

import type { SchoolConfig } from "../config/index.js"
import { modelMappings } from "../models/index.js"
import { coursePaths } from "../store/paths.js"
import { parseVaultDocument } from "../store/vault.js"
import { readDirectory, readOptional } from "../util/fs.js"
import { groupCategoryFromContent } from "./assignment.js"
import type { DogfoodTarget } from "./dogfood-types.js"

export class DogfoodEngineError extends Error {
  readonly name = "DogfoodEngineError"
}

export type DogfoodState = {
  courseCode?: string | undefined
  courseCanvasId?: string | undefined
  courseCanvasUrl?: string | undefined
  gapsCount?: number | undefined
  permissionGapsCount?: number | undefined
  assignmentCanvasId?: string | undefined
  assignmentTitle?: string | undefined
  assignmentCanvasUrl?: string | undefined
  assignmentGroupCategoryId?: string | null | undefined
  draftRunId?: string | undefined
  draftPath?: string | undefined
}

type PersistedFlow = { readonly name: string; readonly status: string; readonly evidence: string }

/** sync flow evidence: "courseCode=<code> courseId=<id> ...". */
export async function hydrateDogfoodState(
  resultsPath: string,
  target: DogfoodTarget,
  state: DogfoodState,
): Promise<void> {
  const flows = await matchingPersistedFlows(resultsPath, target)
  if (flows === null) {
    return
  }
  const sync = passedEvidence(flows, "sync")
  if (sync !== null) {
    state.courseCode = /courseCode=(\S+)/.exec(sync)?.[1]
    state.courseCanvasId = /courseId=(\S+)/.exec(sync)?.[1]
    state.courseCanvasUrl = /courseUrl=(\S+)/.exec(sync)?.[1]
    state.gapsCount = numberField(/gaps=(\d+)/.exec(sync)?.[1])
    state.permissionGapsCount = numberField(/permissionGaps=(\d+)/.exec(sync)?.[1])
  }
  // draft flow evidence: "runId=<id> path=<absolute vault path> assignmentId=<id>
  // assignmentTitle=<slug> assignmentUrl=<url> groupCategoryId=<id|none>".
  const draft = passedEvidence(flows, "draft (no guidance)")
  if (draft !== null) {
    state.draftRunId = /runId=(\S+)/.exec(draft)?.[1]
    state.draftPath = /path=(\S+)/.exec(draft)?.[1]
    state.assignmentCanvasId = /assignmentId=(\S+)/.exec(draft)?.[1]
    state.assignmentTitle = /assignmentTitle=(\S+)/.exec(draft)?.[1]
    state.assignmentCanvasUrl = /assignmentUrl=(\S+)/.exec(draft)?.[1]
    const groupCategoryId = /groupCategoryId=(\S+)/.exec(draft)?.[1]
    state.assignmentGroupCategoryId =
      groupCategoryId === undefined || groupCategoryId === "none" ? null : groupCategoryId
  }
}

async function matchingPersistedFlows(
  resultsPath: string,
  target: DogfoodTarget,
): Promise<readonly PersistedFlow[] | null> {
  const raw = await readOptional(resultsPath)
  if (raw === null) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as {
      course?: string
      week?: string
      assignment?: string
      flows?: readonly PersistedFlow[]
    }
    const matches =
      parsed.course === target.course &&
      parsed.week === target.week &&
      parsed.assignment === target.assignment &&
      parsed.flows !== undefined
    return matches ? (parsed.flows ?? null) : null
  } catch {
    return null
  }
}

function numberField(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number.parseInt(value, 10)
}

function passedEvidence(flows: readonly PersistedFlow[], name: string): string | null {
  const flow = flows.find((candidate) => candidate.name === name && candidate.status === "pass")
  return flow === undefined || flow.evidence.length === 0 ? null : flow.evidence
}

export function requireCourseCode(state: DogfoodState): string {
  if (state.courseCode === undefined) {
    throw new DogfoodEngineError("no synced course code available; the sync flow must run first")
  }
  return state.courseCode
}

export function requireCourseCanvasId(state: DogfoodState): string {
  if (state.courseCanvasId === undefined) {
    throw new DogfoodEngineError(
      "no synced course canvas id available; the sync flow must run first",
    )
  }
  return state.courseCanvasId
}

export function requireCourse(state: DogfoodState): {
  readonly code: string
  readonly canvasId: string
  readonly canvasUrl: string
  readonly aiPolicy: "allowed"
} {
  const code = requireCourseCode(state)
  const canvasId = requireCourseCanvasId(state)
  if (state.courseCanvasUrl === undefined) {
    throw new DogfoodEngineError(
      "no synced course canvas url available; the sync flow must run first",
    )
  }
  return { code, canvasId, canvasUrl: state.courseCanvasUrl, aiPolicy: "allowed" }
}

export function requireAssignment(state: DogfoodState): {
  readonly canvasId: string
  readonly title: string
  readonly canvasUrl: string
  readonly groupCategoryId: string | null
} {
  if (
    state.assignmentCanvasId === undefined ||
    state.assignmentTitle === undefined ||
    state.assignmentCanvasUrl === undefined
  ) {
    throw new DogfoodEngineError("no drafted assignment available; the draft flow must run first")
  }
  return {
    canvasId: state.assignmentCanvasId,
    title: state.assignmentTitle,
    canvasUrl: state.assignmentCanvasUrl,
    groupCategoryId: state.assignmentGroupCategoryId ?? null,
  }
}

export function requireDraftRunId(state: DogfoodState): string {
  if (state.draftRunId === undefined) {
    throw new DogfoodEngineError("no draft run id available; the draft flow must run first")
  }
  return state.draftRunId
}

export function requireDraftPath(state: DogfoodState): string {
  if (state.draftPath === undefined) {
    throw new DogfoodEngineError("no draft path available; the draft flow must run first")
  }
  return state.draftPath
}

export function functionModel(
  config: SchoolConfig,
  functionName: "prepBrief" | "assignmentDraft" | "assignmentDiscuss",
): string {
  const mapping = modelMappings(config).find(
    (candidate) => candidate.key === `models.functions.${functionName}`,
  )
  if (mapping === undefined) {
    throw new DogfoodEngineError(`Missing models.functions.${functionName} mapping.`)
  }
  return mapping.model
}

export async function locateAssignment(
  vaultRoot: string,
  course: { readonly code: string; readonly canvasId: string },
  requested: string | undefined,
): Promise<{
  readonly canvasId: string
  readonly title: string
  readonly canvasUrl: string
  readonly groupCategoryId: string | null
}> {
  const paths = coursePaths(vaultRoot, course.code, course.canvasId)
  const entries = (await readDirectory(paths.assignments))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const path = join(paths.assignments, entry.name)
    const document = parseVaultDocument(await readFile(path, "utf8"), path)
    const slug = basename(entry.name, ".md")
    if (
      requested !== undefined &&
      requested !== document.frontmatter.canvas_id &&
      requested !== slug
    ) {
      continue
    }
    return {
      canvasId: document.frontmatter.canvas_id,
      title: slug,
      canvasUrl: document.frontmatter.canvas_url,
      groupCategoryId: groupCategoryFromContent(document.content),
    }
  }
  throw new DogfoodEngineError(
    requested === undefined
      ? `No assignments synced for ${course.code}; run the sync flow first.`
      : `Assignment not found in ${course.code}: ${requested}.`,
  )
}
