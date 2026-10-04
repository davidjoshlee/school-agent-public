import type { Dirent } from "node:fs"
import { lstat, readdir, readFile } from "node:fs/promises"
import { join, sep } from "node:path"

import { createGateway } from "ai"

import { AISDKAgentRunner } from "../agents/runner.js"
import type { SchoolConfig } from "../config/index.js"
import { modelMappings } from "../models/index.js"
import { createSchoolIndex } from "../store/db.js"
import { coursePaths, periodPaths, vaultDocumentKinds, vaultLayout } from "../store/paths.js"
import { parseVaultDocument } from "../store/vault-document.js"
import { generatePrepBrief, prepPeriodPlacement } from "./prep.js"
import { selectModulesForPeriod } from "./retrieve-selection.js"
import { createGatewayTriage } from "./retrieve-triage.js"

/** Never replace an existing same-week brief during an unattended run. */
export async function hasExistingWeeklyPrep(
  config: SchoolConfig,
  courseId: string,
  weekStart: string,
): Promise<boolean> {
  const root = coursePaths(config.vault.path, "", courseId).root
  const selection = await selectModulesForPeriod(
    root,
    { kind: "week", value: weekStart },
    { timeZone: config.autoPrep.timeZone },
  )
  const placement = prepPeriodPlacement(selection)
  if (placement !== undefined) {
    const directory = periodPaths(coursePaths(config.vault.path, "", courseId), placement).prep
    try {
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return true
      // An unattended job never writes into a Prep folder containing user material,
      // even when the files have no School Agent frontmatter.
      if ((await readdir(directory)).length > 0) return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  let entries: Dirent<string>[]
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(vaultLayout.markdownExtension)) continue
    if (!entry.parentPath.split(sep).includes(vaultLayout.prepDirectory)) continue
    const path = join(entry.parentPath, entry.name)
    try {
      const document = parseVaultDocument(await readFile(path, "utf8"), path)
      if (
        document.frontmatter.type === vaultDocumentKinds.prep &&
        (document.frontmatter.canvas_id === `prep-week-${weekStart}` ||
          document.frontmatter.dates?.["period"] === `week-${weekStart}`)
      )
        return true
    } catch {
      // User-owned or invalid Markdown is not a School Agent prep artifact.
    }
  }
  return false
}

export async function generateScheduledPrep(
  config: SchoolConfig,
  courseId: string,
  weekStart: string,
): Promise<string> {
  const index = createSchoolIndex({ path: config.index.path })
  try {
    const course = index.courseByCanvasId(courseId)
    if (course === null)
      throw new Error(`Course ${courseId} is not synced; run school-agent sync first`)
    const model = modelMappings(config).find(
      (entry) => entry.key === "models.functions.prepBrief",
    )?.model
    if (model === undefined) throw new Error("Missing prepBrief model mapping")
    const result = await generatePrepBrief({
      vaultRoot: config.vault.path,
      config,
      course: {
        code: course.courseCode,
        canvasId: course.canvasId,
        canvasUrl: new URL(
          `/courses/${encodeURIComponent(courseId)}`,
          config.canvas.baseUrl,
        ).toString(),
        aiPolicy: config.aiPolicyDefault,
      },
      period: { kind: "week", value: weekStart },
      periodTimeZone: config.autoPrep.timeZone,
      preserveExisting: true,
      index,
      runner: new AISDKAgentRunner({
        runsDir: join(config.vault.path, ".agent-runs"),
        model: createGateway()(model),
        tools: {},
      }),
      triage: createGatewayTriage(config, index),
    })
    return result.path
  } finally {
    index.close()
  }
}
