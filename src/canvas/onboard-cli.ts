import type { Command } from "commander"

import { loadConfig, persistCourseSelection } from "../config/index.js"
import { createSchoolIndex } from "../store/db.js"
import { CanvasHttpClient } from "./http.js"
import { listDiscoveredCourses, onboardPilot } from "./onboard.js"

type RootOptions = { readonly config: string }
type CourseListOptions = { readonly all?: boolean }
type OnboardOptions = {
  readonly pilot?: boolean
  readonly fresh?: boolean
  readonly allActive?: boolean
}

export class PilotOptionRequiredError extends Error {
  readonly name = "PilotOptionRequiredError"

  constructor() {
    super("Pilot onboarding requires --pilot.")
  }
}

export class OnboardModeError extends Error {
  readonly name = "OnboardModeError"

  constructor() {
    super("Pass exactly one of: <id> --pilot, or --all-active.")
  }
}

export function registerOnboardCommand(program: Command): void {
  const courses = program.command("courses").description("Discover Canvas courses")
  const list = courses.command("list").description("List active Canvas courses")
  list.option("--all", "include concluded courses")
  list.action(async () => {
    const root = program.opts<RootOptions>()
    const options = list.opts<CourseListOptions>()
    const configuration = loadConfig(root.config)
    const discovered = await listDiscoveredCourses(
      new CanvasHttpClient({
        baseUrl: configuration.canvas.baseUrl,
        tokenEnv: configuration.canvas.tokenEnv,
      }),
    )
    for (const course of options.all === true ? discovered : discovered.filter(isActiveCourse)) {
      console.log(`${course.id}\t${course.enrollment}\t${course.code}\t${course.name}`)
    }
  })

  const onboard = program
    .command("onboard [id]")
    .description("Backfill a selected pilot course, or propose+record an active-course allowlist")
  onboard.option("--pilot", "confirm the selected course is the pilot")
  onboard.option("--fresh", "rebuild the pilot vault subtree from clean state")
  onboard.option("--all-active", "discover active Canvas courses and record them as the allowlist")
  onboard.action(async (courseId: string | undefined) => {
    const root = program.opts<RootOptions>()
    const options = onboard.opts<OnboardOptions>()
    const wantsAllActive = options.allActive === true
    const hasId = courseId !== undefined
    const wantsPilot = hasId || options.pilot === true
    if (wantsAllActive && wantsPilot) throw new OnboardModeError()
    if (!wantsAllActive && !wantsPilot) throw new OnboardModeError()

    const configuration = loadConfig(root.config)
    if (wantsAllActive) {
      await proposeAllActiveAllowlist(configuration, root.config)
      return
    }

    if (!hasId || options.pilot !== true) throw new PilotOptionRequiredError()
    const index = createSchoolIndex({ path: configuration.index.path })
    try {
      const report = await onboardPilot({
        client: new CanvasHttpClient({
          baseUrl: configuration.canvas.baseUrl,
          tokenEnv: configuration.canvas.tokenEnv,
        }),
        configuration,
        configurationPath: root.config,
        index,
        pilotCourseId: courseId,
        ...(options.fresh === true ? { fresh: true } : {}),
        warn: (message) => console.warn(message),
      })
      console.log(`Pilot ${report.course.code} backfilled; submissions=${report.submissions}`)
    } finally {
      index.close()
    }
  })
}

async function proposeAllActiveAllowlist(
  configuration: ReturnType<typeof loadConfig>,
  configPath: string,
): Promise<void> {
  const discovered = await listDiscoveredCourses(
    new CanvasHttpClient({
      baseUrl: configuration.canvas.baseUrl,
      tokenEnv: configuration.canvas.tokenEnv,
    }),
  )
  const active = discovered.filter(isActiveCourse)
  active.forEach((course, index) => {
    console.log(`${index + 1}. ${course.id}\t${course.code}\t${course.name}`)
  })
  persistCourseSelection(
    configPath,
    active.map((course) => course.id),
  )
  console.log(
    `Edit courses.allowlist in ${configPath} to remove any course you don't want synced, then run \`sync\`.`,
  )
}

function isActiveCourse(
  course: Awaited<ReturnType<typeof listDiscoveredCourses>>[number],
): boolean {
  return course.enrollment === "active"
}
