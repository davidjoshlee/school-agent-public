import { describe, expect, it } from "vitest"

import {
  onboardPilot,
  PilotCourseMustBeConcludedError,
  PilotCourseNotFoundError,
} from "../src/canvas/onboard.js"
import { loadConfig } from "../src/config/index.js"
import { createSchoolIndex } from "../src/store/db.js"
import { createConfiguration, installFallbackCourseHandlers } from "./helpers/onboard-fixtures.js"
import { client } from "./helpers/schoolConfig.js"

describe("unresolved pilot eligibility", () => {
  it("accepts an unresolved course with elapsed history and graded submissions", async () => {
    // Given: a course that active/completed discovery does not surface (course "30",
    // workflow_state "available") but that is readable with assignments spanning >= 2
    // weeks and graded submissions.
    installFallbackCourseHandlers({ graded: true })
    const paths = await createConfiguration()
    const index = createSchoolIndex({ path: paths.indexPath })
    const warnings: string[] = []

    // When: the user selects it as the M1 pilot.
    const report = await onboardPilot({
      client: client(),
      configuration: loadConfig(paths.configurationPath),
      configurationPath: paths.configurationPath,
      index,
      pilotCourseId: "30",
      warn: (message) => warnings.push(message),
    })

    // Then: the fallback-eligible course is onboarded, synced with its graded
    // submissions, and persisted as the pilot without a no-submissions warning.
    expect(report.course.enrollment).toBe("unresolved")
    expect(report.course.code).toBe("OIT-30")
    expect(report.submissions).toBeGreaterThan(0)
    expect(loadConfig(paths.configurationPath).courses.pilotCourseId).toBe("30")
    expect(warnings).toHaveLength(0)
    index.close()
  })

  it("refuses an unresolved course that has history but no graded submissions", async () => {
    // Given: a readable unresolved course with >= 2 weeks of history but whose own
    // submissions carry neither a score nor a rubric assessment.
    installFallbackCourseHandlers({ graded: false })
    const paths = await createConfiguration()
    const index = createSchoolIndex({ path: paths.indexPath })

    // When: the user selects it as the M1 pilot.
    const onboarding = onboardPilot({
      client: client(),
      configuration: loadConfig(paths.configurationPath),
      configurationPath: paths.configurationPath,
      index,
      pilotCourseId: "30",
    })

    // Then: onboarding refuses it as not genuinely gradeable.
    await expect(onboarding).rejects.toBeInstanceOf(PilotCourseMustBeConcludedError)
    index.close()
  })

  it("refuses an unresolved course whose content cannot be read", async () => {
    // Given: an unresolved course whose assignment content is permission-blocked.
    installFallbackCourseHandlers({ graded: false, assignmentsReadable: false })
    const paths = await createConfiguration()
    const index = createSchoolIndex({ path: paths.indexPath })

    // When: the user selects it as the M1 pilot.
    const onboarding = onboardPilot({
      client: client(),
      configuration: loadConfig(paths.configurationPath),
      configurationPath: paths.configurationPath,
      index,
      pilotCourseId: "30",
    })

    // Then: onboarding treats it as unavailable and cannot confirm ground truth.
    await expect(onboarding).rejects.toBeInstanceOf(PilotCourseNotFoundError)
    index.close()
  })
})
