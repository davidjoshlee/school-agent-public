import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"
import { onboardPilot, PilotCourseMustBeConcludedError } from "../src/canvas/onboard.js"
import { OnboardModeError, PilotOptionRequiredError } from "../src/canvas/onboard-cli.js"
import { createProgram } from "../src/cli.js"
import { loadConfig } from "../src/config/index.js"
import { createSchoolIndex } from "../src/store/db.js"
import { assignmentPaths, coursePaths } from "../src/store/paths.js"
import { parseVaultDocument } from "../src/store/vault-document.js"
import { createConfiguration, installPilotHandlers } from "./helpers/onboard-fixtures.js"
import { client } from "./helpers/schoolConfig.js"
import { vaultTree } from "./helpers/vaultTree.js"

describe("pilot onboarding", () => {
  it("lists active and concluded courses when all is requested", async () => {
    // Given: Canvas exposes one current course and one concluded course.
    installPilotHandlers("Syllabus")
    const paths = await createConfiguration()
    const lines: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((value: string) => {
      lines.push(value)
    })
    vi.stubEnv("CANVAS_TOKEN", "fixture-token")

    // When: the user lists every discovered course from the CLI.
    try {
      await createProgram().parseAsync([
        "node",
        "school",
        "--config",
        paths.configurationPath,
        "courses",
        "list",
        "--all",
      ])
    } finally {
      vi.unstubAllEnvs()
      log.mockRestore()
    }

    // Then: both enrollment states are shown.
    expect(lines).toEqual([
      "20\tactive\tFIN-20\tCurrent Finance",
      "10\tconcluded\tSTRAT-10\tConcluded Strategy",
    ])
  })

  it("requires a concluded course for the pilot", async () => {
    // Given: Canvas offers an active course alongside a concluded course.
    installPilotHandlers("Syllabus")
    const paths = await createConfiguration()
    const index = createSchoolIndex({ path: paths.indexPath })

    // When: the active course is selected as the pilot.
    const onboarding = onboardPilot({
      client: client(),
      configuration: loadConfig(paths.configurationPath),
      configurationPath: paths.configurationPath,
      index,
      pilotCourseId: "20",
    })

    // Then: onboarding refuses the non-concluded pilot before any backfill starts.
    await expect(onboarding).rejects.toBeInstanceOf(PilotCourseMustBeConcludedError)
    index.close()
  })

  it("persists the concluded pilot, applies the default policy, and backfills submissions", async () => {
    // Given: a concluded course with a synced syllabus.
    installPilotHandlers("Syllabus")
    const paths = await createConfiguration()
    const index = createSchoolIndex({ path: paths.indexPath })

    // When: the user selects it as the pilot course.
    await onboardPilot({
      client: client(),
      configuration: loadConfig(paths.configurationPath),
      configurationPath: paths.configurationPath,
      index,
      pilotCourseId: "10",
    })

    // Then: the configured allowed policy persists and feedback is backfilled.
    const configuration = loadConfig(paths.configurationPath)
    const course = coursePaths(paths.vaultPath, "STRAT-10", "10")
    const syllabus = parseVaultDocument(await readFile(course.syllabus, "utf8"))
    const assignment = assignmentPaths(course, { title: "Case memo" })
    await expect(readFile(assignment.feedback, "utf8")).resolves.toContain(
      "Lead with the evidence.",
    )
    await expect(readFile(course.playbook, "utf8")).resolves.toContain("Lead with the evidence.")
    await expect(readFile(join(course.guidance, "README.md"), "utf8")).resolves.toContain(
      "Guidance",
    )
    expect(configuration.courses.pilotCourseId).toBe("10")
    expect(syllabus.frontmatter.ai_policy).toBe("allowed")
    expect(index.submissionCount("10")).toBe(1)
    index.close()
  })

  it("warns with the fallback ladder when the pilot has no submissions", async () => {
    // Given: a concluded pilot course without assignment submissions.
    installPilotHandlers("Syllabus", false)
    const paths = await createConfiguration()
    const index = createSchoolIndex({ path: paths.indexPath })
    const warnings: string[] = []

    // When: onboarding completes its backfill.
    await onboardPilot({
      client: client(),
      configuration: loadConfig(paths.configurationPath),
      configurationPath: paths.configurationPath,
      index,
      pilotCourseId: "10",
      warn: (message) => warnings.push(message),
    })

    // Then: it completes and supplies the documented M1 fallback choices.
    expect(warnings.join("\n")).toContain(
      "concluded -> active course with >=2 weeks history -> synthetic fixture window",
    )
    index.close()
  })

  it("rebuilds the pilot subtree identically when fresh is requested", async () => {
    // Given: a completed pilot backfill with deterministic Canvas fixture responses.
    installPilotHandlers("Syllabus")
    const paths = await createConfiguration()
    const index = createSchoolIndex({ path: paths.indexPath })
    const input = {
      client: client(),
      configuration: loadConfig(paths.configurationPath),
      configurationPath: paths.configurationPath,
      index,
      pilotCourseId: "10",
    }
    await onboardPilot(input)
    const pilotRoot = coursePaths(paths.vaultPath, "STRAT-10", "10").root
    const baseline = await vaultTree(pilotRoot)

    // When: onboarding is re-run from a fresh pilot vault subtree.
    await onboardPilot({ ...input, fresh: true })

    // Then: all pilot artifacts are byte-identical; sync-log timestamps remain outside the subtree.
    await expect(vaultTree(pilotRoot)).resolves.toEqual(baseline)
    index.close()
  })

  it("proposes and records the active-course allowlist without syncing", async () => {
    // Given: Canvas exposes one active course alongside one concluded course.
    installPilotHandlers("Syllabus")
    const paths = await createConfiguration()
    const lines: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((value: string) => {
      lines.push(value)
    })
    vi.stubEnv("CANVAS_TOKEN", "fixture-token")

    // When: the user proposes and records the active-course allowlist.
    try {
      await createProgram().parseAsync([
        "node",
        "school",
        "--config",
        paths.configurationPath,
        "onboard",
        "--all-active",
      ])
    } finally {
      vi.unstubAllEnvs()
      log.mockRestore()
    }

    // Then: only the active course is proposed, the allowlist is recorded, and nothing is synced.
    expect(lines).toEqual([
      "1. 20\tFIN-20\tCurrent Finance",
      `Edit courses.allowlist in ${paths.configurationPath} to remove any course you don't want synced, then run \`sync\`.`,
    ])
    const configuration = loadConfig(paths.configurationPath)
    expect(configuration.courses.mode).toBe("list")
    expect(configuration.courses.allowlist).toEqual(["20"])
    expect(configuration.courses.pilotCourseId).toBeNull()
    expect(existsSync(paths.vaultPath)).toBe(false)
  })

  it("requires exactly one of <id> --pilot or --all-active", async () => {
    // Given: a valid configuration.
    installPilotHandlers("Syllabus")
    const paths = await createConfiguration()
    vi.stubEnv("CANVAS_TOKEN", "fixture-token")

    try {
      // When/Then: neither mode is selected.
      await expect(
        createProgram().parseAsync([
          "node",
          "school",
          "--config",
          paths.configurationPath,
          "onboard",
        ]),
      ).rejects.toBeInstanceOf(OnboardModeError)

      // When/Then: both modes are selected at once.
      await expect(
        createProgram().parseAsync([
          "node",
          "school",
          "--config",
          paths.configurationPath,
          "onboard",
          "10",
          "--pilot",
          "--all-active",
        ]),
      ).rejects.toBeInstanceOf(OnboardModeError)

      // When/Then: an id without --pilot still reports the pilot-specific error.
      await expect(
        createProgram().parseAsync([
          "node",
          "school",
          "--config",
          paths.configurationPath,
          "onboard",
          "10",
        ]),
      ).rejects.toBeInstanceOf(PilotOptionRequiredError)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
