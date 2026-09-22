/**
 * Builds dogfood flows 1-5 (sync, timeline, guidance, prep, draft) against
 * the real engines. See dogfood-flows-review.ts for flows 6-10 and
 * dogfood-cli.ts for the command that wires both halves together plus
 * `dogfood-state.ts` for the shared mutable state and lookup helpers.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"

import { createGateway } from "ai"

import { AISDKAgentRunner } from "../agents/runner.js"
import type { CanvasHttpClient } from "../canvas/http.js"
import type { SchoolConfig } from "../config/index.js"
import type { SchoolIndex } from "../store/db.js"
import { coursePaths, vaultDocumentKinds } from "../store/paths.js"
import {
  createVaultFrontmatter,
  parseVaultDocument,
  renderVaultDocument,
  vaultAiPolicies,
  vaultSources,
  vaultStatuses,
} from "../store/vault-document.js"
import { readOptional } from "../util/fs.js"
import { draftAssignment } from "./assignment.js"
import { syncFlow } from "./dogfood-flows-sync.js"
import { gatedRunner } from "./dogfood-runners.js"
import {
  DogfoodEngineError,
  type DogfoodState,
  functionModel,
  locateAssignment,
  requireCourse,
  requireCourseCode,
} from "./dogfood-state.js"
import type { DogfoodFlow, DogfoodTarget, PreSyncedCourse } from "./dogfood-types.js"
import { generatePrepBrief, type PrepPeriod } from "./prep.js"
import { createGatewayTriage } from "./retrieve-triage.js"
import { buildTimeline } from "./timeline.js"

export type DogfoodFlowsInput = {
  readonly config: SchoolConfig
  readonly index: SchoolIndex
  readonly client: CanvasHttpClient
  readonly target: DogfoodTarget
  readonly requestedAssignment: string | undefined
  readonly state: DogfoodState
  /** When set, the sync flow verifies against this instead of syncing again. */
  readonly preSynced?: PreSyncedCourse
}

export function buildCoreFlows(input: DogfoodFlowsInput): readonly DogfoodFlow[] {
  return [
    syncFlow(input),
    timelineFlow(input),
    guidanceNoteFlow(input),
    prepBriefFlow(input),
    draftFlow(input),
  ]
}

function timelineFlow(input: DogfoodFlowsInput): DogfoodFlow {
  return {
    name: "timeline",
    kind: "auto",
    async run() {
      const courseCode = requireCourseCode(input.state)
      const timeline = buildTimeline({
        index: input.index,
        weeks: 4,
        course: courseCode,
        now: new Date(),
      })
      if (!Array.isArray(timeline.dated) || !Array.isArray(timeline.undated)) {
        throw new DogfoodEngineError("buildTimeline did not return a structured result")
      }
      return { evidence: `dated-days=${timeline.dated.length} undated=${timeline.undated.length}` }
    },
  }
}

function guidanceNoteFlow(input: DogfoodFlowsInput): DogfoodFlow {
  return {
    name: "guidance note",
    kind: "auto",
    async run() {
      const course = requireCourse(input.state)
      const paths = coursePaths(input.config.vault.path, course.code, course.canvasId)
      const notePath = join(paths.guidance, "dogfood-note.md")
      await mkdir(paths.guidance, { recursive: true })
      const timestamp = new Date().toISOString()
      // Append to the note's body, then write it back as a VALID vault document
      // (frontmatter + body). A bare-markdown file here breaks the next sync's
      // manifest rebuild, which parses every vault doc. Still a user-owned note,
      // just a well-formed one.
      const body = `${guidanceNoteBody(await readOptional(notePath))}\n\n- ${timestamp}: dogfood run touched this course.`
      const frontmatter = createVaultFrontmatter({
        canvasId: "guidance-dogfood",
        canvasUrl: course.canvasUrl,
        type: vaultDocumentKinds.guidance,
        content: body,
        source: vaultSources.user,
        status: vaultStatuses.final,
        aiPolicy: vaultAiPolicies.allowed,
      })
      await writeFile(notePath, renderVaultDocument(frontmatter, body), "utf8")
      const readBack = parseVaultDocument(await readFile(notePath, "utf8"), notePath)
      if (!readBack.content.includes(timestamp)) {
        throw new DogfoodEngineError("guidance note write did not persist")
      }
      return { evidence: relative(input.config.vault.path, notePath) }
    },
  }
}

// The existing note's body if it parses as a vault document; otherwise a fresh
// default (which also self-heals a note a prior run left without frontmatter).
function guidanceNoteBody(existing: string | null): string {
  const fallback = "# Dogfood guidance note\n\nUser-owned note touched by the M2 dogfood run."
  if (existing === null) {
    return fallback
  }
  try {
    return parseVaultDocument(existing).content.trim()
  } catch {
    return fallback
  }
}

function prepBriefFlow(input: DogfoodFlowsInput): DogfoodFlow {
  return {
    name: "prep brief",
    kind: "auto",
    async run() {
      const course = requireCourse(input.state)
      const period: PrepPeriod = { kind: "week", value: input.target.week }
      const runner = new AISDKAgentRunner({
        runsDir: join(input.config.vault.path, ".agent-runs"),
        model: createGateway()(functionModel(input.config, "prepBrief")),
        tools: {},
      })
      const result = await generatePrepBrief({
        vaultRoot: input.config.vault.path,
        config: input.config,
        course,
        period,
        index: input.index,
        runner,
        triage: createGatewayTriage(input.config, input.index),
      })
      const content = await readFile(result.path, "utf8")
      if (content.trim().length === 0) {
        throw new DogfoodEngineError("prep brief file is empty")
      }
      return { evidence: relative(input.config.vault.path, result.path), human: "" }
    },
  }
}

function draftFlow(input: DogfoodFlowsInput): DogfoodFlow {
  return {
    name: "draft (no guidance)",
    kind: "auto",
    async run() {
      const course = requireCourse(input.state)
      const assignment = await locateAssignment(
        input.config.vault.path,
        course,
        input.requestedAssignment,
      )
      input.state.assignmentCanvasId = assignment.canvasId
      input.state.assignmentTitle = assignment.title
      input.state.assignmentCanvasUrl = assignment.canvasUrl
      input.state.assignmentGroupCategoryId = assignment.groupCategoryId
      const result = await draftAssignment({
        vaultRoot: input.config.vault.path,
        config: input.config,
        course,
        assignment,
        runner: gatedRunner(input.config, "assignmentDraft"),
        index: input.index,
        triage: createGatewayTriage(input.config, input.index),
      })
      input.state.draftRunId = result.runId
      input.state.draftPath = result.path
      const content = await readFile(result.path, "utf8")
      if (content.trim().length === 0) {
        throw new DogfoodEngineError("draft file is empty")
      }
      return {
        evidence: `runId=${result.runId} path=${result.path} assignmentId=${assignment.canvasId} assignmentTitle=${assignment.title} assignmentUrl=${assignment.canvasUrl} groupCategoryId=${assignment.groupCategoryId ?? "none"}`,
        human: "",
      }
    },
  }
}
