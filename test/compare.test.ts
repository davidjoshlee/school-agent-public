import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import type { SchoolConfig } from "../src/config/index.js"
import { renderAssignmentProvenance } from "../src/engines/assignment-provenance.js"
import { compareSimulation } from "../src/engines/compare.js"
import { coursePaths, slugify } from "../src/store/paths.js"
import { renderVaultDocument } from "../src/store/vault.js"
import { createVaultFrontmatter } from "../src/store/vault-document.js"
import { schoolConfig } from "./helpers/schoolConfig.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

const course = {
  code: "STRAT 101",
  canvasId: "course-17",
  canvasUrl: "https://canvas.example.invalid/courses/course-17",
} as const

function config(root: string): SchoolConfig {
  return schoolConfig({
    vaultPath: root,
    canvas: { baseUrl: "https://canvas.example.invalid" },
    courses: { pilotCourseId: course.canvasId },
  })
}

function simulationRunId(asOf = "2025-01-01"): string {
  const weekKey = `${slugify(course.code, `course-${course.canvasId}`)}-${slugify(course.canvasId, "unknown")}-${asOf}`
  return join(weekKey, coursePaths("", course.code, course.canvasId).root)
}

function vaultDocument(content: string): string {
  return renderVaultDocument(
    createVaultFrontmatter({
      canvasId: "fixture",
      canvasUrl: "https://canvas.example.invalid/resource",
      type: "fixture",
      content,
      dates: { created_at: "2025-01-01T00:00:00.000Z" },
      source: "sync",
      status: "final",
      aiPolicy: "allowed",
    }),
    content,
  )
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, "utf8")
}

async function fixtureVault(withFeedback: boolean): Promise<string> {
  const root = await temporaryDirectory("school-agent-compare-")
  const paths = coursePaths(root, course.code, course.canvasId)
  await write(
    paths.index,
    renderVaultDocument(
      createVaultFrontmatter({
        canvasId: course.canvasId,
        canvasUrl: course.canvasUrl,
        type: "index",
        content: "# STRAT 101",
        dates: { created_at: "2025-01-01T00:00:00.000Z" },
        source: "sync",
        status: "final",
        aiPolicy: "allowed",
      }),
      "# STRAT 101",
    ),
  )
  if (withFeedback) {
    await write(
      join(paths.assignments, "pricing-memo.feedback.md"),
      vaultDocument(
        [
          "Rubric assessment:",
          "",
          "```json",
          JSON.stringify({ "market-analysis": { points: 5 }, evidence: { points: 0 } }),
          "```",
        ].join("\n"),
      ),
    )
  }
  const runId = simulationRunId()
  const weekRoot = join(root, "_simulations", runId)
  await write(join(weekRoot, "modules", "market-analysis.md"), vaultDocument("Market analysis"))
  await write(join(weekRoot, "modules", "competitor-data.md"), vaultDocument("Competitor data"))
  await write(join(weekRoot, "prep", "week.md"), vaultDocument("## Agenda\n\nMarket analysis"))
  const draft = [
    renderAssignmentProvenance({
      course: { code: course.code, canvas_id: course.canvasId, canvas_url: course.canvasUrl },
      assignment: {
        canvas_id: "assignment-1",
        title: "Pricing memo",
        slug: "pricing-memo",
        canvas_url: "https://canvas.example.invalid/assignments/assignment-1",
        group_category_id: null,
      },
      ai_policy: "allowed",
      model_ids: { draft: "mock/draft", discuss: "mock/discuss" },
      source_files: ["modules/market-analysis.md"],
      timestamp: "2025-01-01T00:00:00.000Z",
      version: 1,
      run_id: "00000000-0000-4000-8000-000000000001",
    }),
    "## Market analysis\n\nTODO: evidence",
  ].join("\n\n")
  await write(join(weekRoot, "drafts", "pricing-memo.md"), vaultDocument(draft))
  await write(
    join(weekRoot, "report.json"),
    `${JSON.stringify(
      {
        runId,
        unknownVisibility: 0,
        leakageCount: 0,
        weeks: [
          {
            asOf: "2025-01-01",
            status: "completed",
            brief: { path: "prep/week.md", sources: [] },
            drafts: [{ path: "drafts/pricing-memo.md", sources: [] }],
          },
        ],
      },
      null,
      2,
    )}\n`,
  )
  return root
}

describe("simulation ground-truth comparison", () => {
  it("renders one coverage row per real rubric criterion and pre-lists all artifacts", async () => {
    // Given: a replayed draft, its week's staged materials, and synced real rubric feedback.
    const root = await fixtureVault(true)
    try {
      // When: the comparator reads the local simulation and pilot vault without network access.
      const result = await compareSimulation({
        config: config(root),
        runId: simulationRunId(),
      })

      // Then: coverage—not similarity to the final submission—is reported for every criterion.
      const comparison = await readFile(result.comparisonPath, "utf8")
      const scorecard = await readFile(result.scorecardPath, "utf8")
      expect(comparison).toMatch(/\| market analysis \| hit \|/)
      expect(comparison).toMatch(/\| evidence \| missed-but-flagged \|/)
      expect(comparison).toContain("competitor-data.md")
      expect(comparison).toContain("not similarity-to-final")
      expect(scorecard).toContain("brief: 2025-01-01")
      expect(scorecard).toContain("draft: pricing-memo")
      expect(scorecard).toContain("1 / 2 / 3 / 4 / 5")
      expect(scorecard).toContain("would have used this as my starting point with light edits")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports missing submissions as no ground truth without fabricating a comparison", async () => {
    // Given: a replayed draft whose pilot assignment has no synced feedback or submission.
    const root = await fixtureVault(false)
    try {
      // When: the local comparison is generated.
      const result = await compareSimulation({
        config: config(root),
        runId: simulationRunId(),
      })

      // Then: the artifact remains scorecard-ready and explicitly has no ground truth.
      expect(await readFile(result.comparisonPath, "utf8")).toContain("no ground truth")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
