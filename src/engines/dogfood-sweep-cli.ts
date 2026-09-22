/**
 * Real-engine wiring for `dogfood --sessions <n>`: syncs once to learn the
 * course's vault directory, resolves the first N teaching sessions
 * (dogfood-sweep-resolve.ts), builds each session's flows from the same
 * buildCoreFlows/buildReviewFlows used by the single-session `dogfood`
 * command, and hands them to `runDogfoodSweep`. A prep-only session (no
 * linked assignment) gets its draft/co-edit/approve flows replaced with a
 * flow that throws `DogfoodFlowSkip` — recorded as "skipped", not "fail".
 */
import { basename } from "node:path"

import { CanvasHttpClient } from "../canvas/http.js"
import { resolveSyncSelection } from "../canvas/resolve-sync-selection.js"
import { syncCanvas } from "../canvas/sync.js"
import type { SchoolConfig } from "../config/index.js"
import { createSchoolIndex, type SchoolIndex } from "../store/db.js"
import { coursePaths } from "../store/paths.js"
import { buildCoreFlows } from "./dogfood-flows.js"
import { buildReviewFlows } from "./dogfood-flows-review.js"
import type { DogfoodState } from "./dogfood-state.js"
import { type DogfoodSweepIndex, runDogfoodSweep } from "./dogfood-sweep.js"
import { resolveDogfoodSessions } from "./dogfood-sweep-resolve.js"
import {
  type DogfoodFlow,
  DogfoodFlowSkip,
  type DogfoodSweepSession,
  type PreSyncedCourse,
} from "./dogfood-types.js"

export class DogfoodSweepCommandError extends Error {
  readonly name = "DogfoodSweepCommandError"
}

export type RunDogfoodSweepCommandInput = {
  readonly config: SchoolConfig
  readonly course: string
  readonly sessionCount: number
  readonly fresh: boolean
}

export async function runDogfoodSweepCommand(
  input: RunDogfoodSweepCommandInput,
): Promise<DogfoodSweepIndex> {
  const index = createSchoolIndex({ path: input.config.index.path })
  try {
    const client = new CanvasHttpClient({
      baseUrl: input.config.canvas.baseUrl,
      tokenEnv: input.config.canvas.tokenEnv,
    })
    // Ended courses (enrollment "none") aren't in discovery — resolve an
    // override so this learn-the-vault-dir sync actually syncs them.
    const selection = await resolveSyncSelection(client, input.course)
    const report = await syncCanvas({
      client,
      canvasBaseUrl: input.config.canvas.baseUrl,
      vaultPath: input.config.vault.path,
      index,
      gitInit: input.config.vault.gitInit,
      maxFileSizeMB: input.config.files.maxSizeMB,
      restrictedFileHandling: input.config.restrictedFileHandling,
      leadDays: input.config.sync.leadDays,
      courseIds: selection.courseIds,
      ...(selection.courseOverrides === undefined
        ? {}
        : { courseOverrides: selection.courseOverrides }),
      // Silence the desktop due-soon popup for the sweep's own pre-sync (the
      // per-session sync flow silences its own); a sweep must not spam alerts.
      dueSoonNotifier: async () => {},
    })
    const course = report.courses[0]
    if (course === undefined || course.status !== "synced") {
      throw new DogfoodSweepCommandError(
        `sync failed for course ${input.course}: ${course?.error ?? "no course report"}`,
      )
    }
    // The course is synced once here; each session's sync flow verifies against
    // this instead of re-downloading the whole course (the run's dominant cost).
    const preSynced: PreSyncedCourse = {
      courseCode: course.courseCode,
      courseId: course.courseId,
      courseUrl: new URL(`/courses/${course.courseId}`, input.config.canvas.baseUrl).toString(),
      gaps: course.gaps.length,
      permissionGaps: course.permissionGaps.length,
    }
    const coursePathsForSlug = coursePaths(
      input.config.vault.path,
      course.courseCode,
      course.courseId,
    )
    const sessions = await resolveDogfoodSessions(coursePathsForSlug.root, input.sessionCount)
    if (sessions.length === 0) {
      throw new DogfoodSweepCommandError(
        `no "Session N" modules found for course ${input.course}; sync it first`,
      )
    }

    return await runDogfoodSweep({
      course: input.course,
      courseSlug: basename(coursePathsForSlug.root),
      vaultRoot: input.config.vault.path,
      sessions,
      fresh: input.fresh,
      buildFlows: (session) =>
        buildSessionFlows(input.config, index, client, input.course, session, preSynced),
    })
  } finally {
    index.close()
  }
}

function buildSessionFlows(
  config: SchoolConfig,
  index: SchoolIndex,
  client: CanvasHttpClient,
  course: string,
  session: DogfoodSweepSession,
  preSynced: PreSyncedCourse,
): readonly DogfoodFlow[] {
  const state: DogfoodState = {}
  const coreFlows = buildCoreFlows({
    config,
    index,
    client,
    preSynced,
    target: { course, week: session.weekDate, assignment: session.assignmentId ?? "none" },
    requestedAssignment: session.assignmentId ?? undefined,
    state,
  })
  const reviewFlows = buildReviewFlows({ config, index, state })
  if (session.assignmentId !== null) {
    return [...coreFlows, ...reviewFlows]
  }
  const reason = "no draftable assignment this session"
  return [
    ...skipNamed(coreFlows, ["draft (no guidance)"], reason),
    ...skipNamed(reviewFlows, ["co-edit", "approve"], reason),
  ]
}

function skipNamed(
  flows: readonly DogfoodFlow[],
  names: readonly string[],
  reason: string,
): readonly DogfoodFlow[] {
  return flows.map((flow) =>
    names.includes(flow.name)
      ? {
          name: flow.name,
          kind: flow.kind,
          run: async () => {
            throw new DogfoodFlowSkip(reason)
          },
        }
      : flow,
  )
}
