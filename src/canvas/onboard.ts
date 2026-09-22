import { rm } from "node:fs/promises"

import { persistPilotCourse, type SchoolConfig } from "../config/index.js"
import type { SchoolIndex } from "../store/db.js"
import { coursePaths, vaultDocumentKinds } from "../store/paths.js"
import { type VaultWriteResult, VaultWriter, vaultSources, vaultStatuses } from "../store/vault.js"
import { type Course, dedupeCoursesById, listCourses } from "./endpoints.js"
import type { CanvasHttpClient } from "./http.js"
import { probeUnresolvedCourse } from "./onboard-eligibility.js"
import { syncCanvas } from "./sync.js"

type Enrollment = "active" | "concluded" | "unresolved"

export type DiscoveredCourse = {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly enrollment: Enrollment
}

export type PilotOnboardingInput = {
  readonly client: CanvasHttpClient
  readonly configuration: SchoolConfig
  readonly configurationPath: string
  readonly index: SchoolIndex
  readonly pilotCourseId: string
  readonly fresh?: boolean
  readonly warn?: (message: string) => void
}

export type PilotOnboardingReport = {
  readonly course: DiscoveredCourse
  readonly submissions: number
}

export class PilotCourseNotFoundError extends Error {
  readonly name = "PilotCourseNotFoundError"

  constructor(readonly pilotCourseId: string) {
    super(`Canvas did not discover pilot course ${pilotCourseId}. Run school courses list --all.`)
  }
}

export class PilotCourseMustBeConcludedError extends Error {
  readonly name = "PilotCourseMustBeConcludedError"

  constructor(readonly pilotCourseId: string) {
    super(`Pilot course ${pilotCourseId} must be concluded. Run school courses list --all.`)
  }
}

const guidanceTemplate = "# Guidance\n\nAdd course-specific guidance here.\n"
const submissionFallback =
  "No submissions were backfilled. M1 fallback ladder: concluded -> active course with >=2 weeks history -> synthetic fixture window."

export async function listDiscoveredCourses(
  client: CanvasHttpClient,
): Promise<readonly DiscoveredCourse[]> {
  const [active, concluded] = await Promise.all([
    listCourses(client, "active"),
    listCourses(client, "completed"),
  ])
  const concludedIds = new Set(concluded.map((course) => String(course.id)))
  return dedupeCoursesById(active, concluded).map((course) =>
    discovered(course, concludedIds.has(String(course.id)) ? "concluded" : "active"),
  )
}

export async function onboardPilot(input: PilotOnboardingInput): Promise<PilotOnboardingReport> {
  const course = await resolveEligiblePilotCourse(input.client, input.pilotCourseId)

  persistPilotCourse(input.configurationPath, course.id)
  const paths = coursePaths(input.configuration.vault.path, course.code, course.id)
  if (input.fresh === true) await rm(paths.root, { recursive: true, force: true })

  await syncCanvas({
    client: input.client,
    canvasBaseUrl: input.configuration.canvas.baseUrl,
    vaultPath: input.configuration.vault.path,
    index: input.index,
    gitInit: input.configuration.vault.gitInit,
    maxFileSizeMB: input.configuration.files.maxSizeMB,
    courseIds: [course.id],
    courseOverrides: {
      [course.id]: { id: course.id, course_code: course.code, name: course.name },
    },
    courseAiPolicies: { [course.id]: input.configuration.aiPolicyDefault },
  })

  const writer = new VaultWriter({
    root: input.configuration.vault.path,
    gitInit: input.configuration.vault.gitInit,
  })
  await writeGuidance(writer, input.configuration, course)
  const submissions = input.index.submissionCount(course.id)
  if (submissions === 0) input.warn?.(submissionFallback)
  return { course, submissions }
}

function discovered(course: Course, enrollment: Enrollment): DiscoveredCourse {
  const id = String(course.id)
  return {
    id,
    code: course.course_code ?? `course-${id}`,
    name: course.name ?? `Course ${id}`,
    enrollment,
  }
}

async function resolveEligiblePilotCourse(
  client: CanvasHttpClient,
  pilotCourseId: string,
): Promise<DiscoveredCourse> {
  const discoveredCourse = (await listDiscoveredCourses(client)).find(
    (candidate) => candidate.id === pilotCourseId || candidate.code === pilotCourseId,
  )
  if (discoveredCourse !== undefined) {
    if (discoveredCourse.enrollment === "concluded") return discoveredCourse
    throw new PilotCourseMustBeConcludedError(discoveredCourse.id)
  }

  const verdict = await probeUnresolvedCourse(client, pilotCourseId)
  switch (verdict.kind) {
    case "eligible":
      return verdict.course
    case "ineligible":
      throw new PilotCourseMustBeConcludedError(pilotCourseId)
    case "unavailable":
      throw new PilotCourseNotFoundError(pilotCourseId)
  }
}

function writeGuidance(
  writer: VaultWriter,
  configuration: SchoolConfig,
  course: DiscoveredCourse,
): Promise<VaultWriteResult> {
  return writer.write({
    course: {
      code: course.code,
      canvasId: course.id,
      canvasUrl: new URL(
        `/courses/${encodeURIComponent(course.id)}`,
        configuration.canvas.baseUrl,
      ).toString(),
      aiPolicy: configuration.aiPolicyDefault,
    },
    kind: vaultDocumentKinds.guidance,
    title: "README",
    canvasId: "guidance-template",
    canvasUrl: configuration.canvas.baseUrl,
    content: guidanceTemplate,
    source: vaultSources.agent,
    status: vaultStatuses.final,
  })
}
