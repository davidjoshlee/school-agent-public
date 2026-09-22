/**
 * `school dogfood`: runs the 10 core M2 flows (sync, timeline, guidance,
 * prep, draft, co-edit, approve, token-renewal alert, gaps re-check, cost
 * report) end-to-end against the real engines and writes a machine-readable
 * scorecard to `vault/_meta/dogfood-results.json` (plus a readable
 * `dogfood-<date>.md`). See dogfood.ts for the resumable orchestration core
 * and dogfood-flows.ts / dogfood-flows-review.ts for the flow wiring.
 */
import { join } from "node:path"

import type { Command } from "commander"

import { CanvasHttpClient } from "../canvas/http.js"
import { loadConfig, type SchoolConfig } from "../config/index.js"
import { createSchoolIndex } from "../store/db.js"
import { vaultPaths } from "../store/paths.js"
import { runDogfood } from "./dogfood.js"
import { buildCoreFlows } from "./dogfood-flows.js"
import { buildReviewFlows } from "./dogfood-flows-review.js"
import { type DogfoodState, hydrateDogfoodState } from "./dogfood-state.js"
import { runDogfoodSweepCommand } from "./dogfood-sweep-cli.js"
import type { DogfoodTarget } from "./dogfood-types.js"

type RootOptions = { readonly config: string }
type DogfoodOptions = {
  readonly course?: string
  readonly week?: string
  readonly assignment?: string
  readonly fresh?: boolean
  readonly sessions?: string
}

export class DogfoodCommandError extends Error {
  readonly name = "DogfoodCommandError"
}

export function registerDogfoodCommand(program: Command): void {
  const dogfood = program
    .command("dogfood")
    .description("Run the 10 core M2 flows end-to-end and write a machine-readable scorecard")
    .option("--course <id>", "Canvas course id to run the flows against")
    .option("--week <YYYY-MM-DD>", "period for the prep flow (default: today)")
    .option("--assignment <id-or-slug>", "assignment for the draft/co-edit/approve flows")
    .option("--fresh", "ignore any prior dogfood-results.json and rerun every flow")
    .option(
      "--sessions <n>",
      "run a session sweep: dogfood the first N teaching sessions, one run each",
    )
  dogfood.action(async () => {
    const root = program.opts<RootOptions>()
    const options = dogfood.opts<DogfoodOptions>()
    const configuration = loadConfig(root.config)

    if (options.sessions !== undefined) {
      await runSweep(configuration.courses.pilotCourseId, configuration, options)
      return
    }

    const target = resolveTarget(configuration.courses.pilotCourseId, options)

    const paths = vaultPaths(configuration.vault.path)
    const resultsPath = join(paths.metadata.directory, "dogfood-results.json")
    const summaryPath = join(paths.metadata.directory, `dogfood-${todayIso()}.md`)

    const index = createSchoolIndex({ path: configuration.index.path })
    try {
      const client = new CanvasHttpClient({
        baseUrl: configuration.canvas.baseUrl,
        tokenEnv: configuration.canvas.tokenEnv,
      })
      const state: DogfoodState = {}
      if (options.fresh !== true) {
        await hydrateDogfoodState(resultsPath, target, state)
      }
      const flows = [
        ...buildCoreFlows({
          config: configuration,
          index,
          client,
          target,
          requestedAssignment: options.assignment,
          state,
        }),
        ...buildReviewFlows({ config: configuration, index, state }),
      ]
      const summary = await runDogfood({
        flows,
        target,
        resultsPath,
        summaryPath,
        ...(options.fresh === true ? { fresh: true } : {}),
      })
      console.log(resultsPath)
      console.log(summaryPath)
      console.log(`${summary.passed}/${summary.total} passed`)
    } finally {
      index.close()
    }
  })
}

async function runSweep(
  pilotCourseId: string | null,
  configuration: SchoolConfig,
  options: DogfoodOptions,
): Promise<void> {
  const course = options.course ?? pilotCourseId ?? undefined
  if (course === undefined) {
    throw new DogfoodCommandError(
      "No course to dogfood: pass --course <id> or set courses.pilotCourseId in school.config.json.",
    )
  }
  const sessionCount = Number.parseInt(options.sessions ?? "", 10)
  if (!Number.isInteger(sessionCount) || sessionCount <= 0) {
    throw new DogfoodCommandError(`--sessions must be a positive integer, got: ${options.sessions}`)
  }
  const sweepIndex = await runDogfoodSweepCommand({
    config: configuration,
    course,
    sessionCount,
    fresh: options.fresh === true,
  })
  console.log(`Dogfood sweep: ${sweepIndex.entries.length} session(s) for ${sweepIndex.courseSlug}`)
  for (const entry of sweepIndex.entries) {
    const flag = entry.failed ? " (FAILED)" : ""
    console.log(
      `session ${entry.session.sessionNumber} (${entry.session.weekDate}): ${entry.passed}/${entry.total} passed, ${entry.skipped} skipped${flag}`,
    )
  }
}

function resolveTarget(pilotCourseId: string | null, options: DogfoodOptions): DogfoodTarget {
  const course = options.course ?? pilotCourseId ?? undefined
  if (course === undefined) {
    throw new DogfoodCommandError(
      "No course to dogfood: pass --course <id> or set courses.pilotCourseId in school.config.json.",
    )
  }
  return {
    course,
    week: options.week ?? todayIso(),
    assignment: options.assignment ?? "auto",
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}
