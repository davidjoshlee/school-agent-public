/**
 * The dogfood "sync" flow (flow 1), split out of dogfood-flows.ts to keep that
 * file under the size ceiling. It either verifies against a course the sweep
 * already synced once (`input.preSynced`) or performs the real sync, populating
 * the shared DogfoodState the later flows read.
 */
import { resolveSyncSelection } from "../canvas/resolve-sync-selection.js"
import { syncCanvas } from "../canvas/sync.js"
import type { DogfoodFlowsInput } from "./dogfood-flows.js"
import { DogfoodEngineError } from "./dogfood-state.js"
import type { DogfoodFlow } from "./dogfood-types.js"

export function syncFlow(input: DogfoodFlowsInput): DogfoodFlow {
  return {
    name: "sync",
    kind: "auto",
    async run() {
      // In a sweep the course is synced once up front; each session verifies
      // against that instead of re-downloading the whole course (the run's
      // dominant cost). The vault the later flows read is identical.
      if (input.preSynced !== undefined) {
        const pre = input.preSynced
        input.state.courseCode = pre.courseCode
        input.state.courseCanvasId = pre.courseId
        input.state.courseCanvasUrl = pre.courseUrl
        input.state.gapsCount = pre.gaps
        input.state.permissionGapsCount = pre.permissionGaps
        return {
          evidence: `verified (synced once for the sweep) courseCode=${pre.courseCode} courseId=${pre.courseId} gaps=${pre.gaps} permissionGaps=${pre.permissionGaps}`,
        }
      }
      // Resolve the sync selection so an ENDED course (enrollment "none", which
      // discovery won't surface, e.g. a past-year pilot) is supplied as an
      // override instead of selecting nothing and no-op'ing.
      const selection = await resolveSyncSelection(input.client, input.target.course)
      const report = await syncCanvas({
        client: input.client,
        canvasBaseUrl: input.config.canvas.baseUrl,
        vaultPath: input.config.vault.path,
        index: input.index,
        gitInit: input.config.vault.gitInit,
        maxFileSizeMB: input.config.files.maxSizeMB,
        restrictedFileHandling: input.config.restrictedFileHandling,
        leadDays: input.config.sync.leadDays,
        courseIds: selection.courseIds,
        ...(selection.courseOverrides === undefined
          ? {}
          : { courseOverrides: selection.courseOverrides }),
        // A dogfood sync is a verification harness, not the daily sync: suppress
        // the desktop due-soon popup. ALERT.md is still written.
        dueSoonNotifier: async () => {},
      })
      const course = report.courses[0]
      if (course === undefined) {
        throw new DogfoodEngineError(`sync produced no course report for ${input.target.course}`)
      }
      input.state.courseCode = course.courseCode
      input.state.courseCanvasId = course.courseId
      input.state.courseCanvasUrl = new URL(
        `/courses/${course.courseId}`,
        input.config.canvas.baseUrl,
      ).toString()
      input.state.gapsCount = course.gaps.length
      input.state.permissionGapsCount = course.permissionGaps.length
      if (course.status !== "synced") {
        throw new DogfoodEngineError(
          `sync failed for ${course.courseCode}: ${course.error ?? "unknown error"}`,
        )
      }
      return {
        evidence: `courseCode=${course.courseCode} courseId=${course.courseId} courseUrl=${input.state.courseCanvasUrl} changes=${course.changes.length} gaps=${course.gaps.length} permissionGaps=${course.permissionGaps.length}`,
      }
    },
  }
}
