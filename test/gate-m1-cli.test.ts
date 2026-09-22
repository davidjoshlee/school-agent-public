import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { createSchoolIndex } from "../src/store/db.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))

type SchoolResult = {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

function runSchool(arguments_: readonly string[]): Promise<SchoolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...arguments_], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }))
  })
}

async function writeSimulationRun(
  vaultPath: string,
  runId: string,
  withComparison: boolean,
  includeVisibility = true,
): Promise<void> {
  const runRoot = join(vaultPath, "_simulations", runId)
  const draftPath = "drafts/pricing-memo.md"
  await mkdir(runRoot, { recursive: true })
  await writeFile(
    join(runRoot, "report.json"),
    `${JSON.stringify(
      {
        runId,
        unknownVisibility: 2,
        leakageCount: 0,
        ...(includeVisibility
          ? {
              visibility: {
                bySignal: {
                  unlock_at: 1,
                  posted_at: 0,
                  module_release: 3,
                  due_at: 2,
                  created_at: 0,
                  unknown: 2,
                },
              },
            }
          : {}),
        weeks: [
          {
            asOf: "2025-01-08",
            status: "completed",
            brief: { path: "prep/2025-01-08.md", sources: ["modules/week-one.md"] },
            drafts: [
              {
                path: draftPath,
                sources: [
                  "assignments/pricing-memo.md",
                  "assignments/pricing-memo.md.summary.md",
                  "_index.md",
                ],
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  const draftDirectory = join(runRoot, "drafts")
  await mkdir(draftDirectory, { recursive: true })
  await writeFile(
    join(draftDirectory, "pricing-memo.md"),
    [
      "# Pricing memo",
      "",
      "Body content goes here.",
      "",
      "## Correctness check",
      "",
      "**Verified**",
      "",
      "- The list price of $49 traces to assignments/pricing-memo.md.",
      "",
      "**Needs verification**",
      "",
      "- The competitor benchmark figure is not present in any synced vault source.",
      "",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    join(runRoot, "scorecard.md"),
    [
      "# Anchored human scorecard",
      "",
      "- 1 — unusable without a full rewrite.",
      "- 2 — useful fragments, but substantial restructuring required.",
      "- 3 — a workable direction requiring material edits.",
      "- 4 — would have used this as my starting point with light edits.",
      "- 5 — ready to use with only trivial changes.",
      "",
      "| Artifact | Anchored 1-5 | Notes |",
      "| --- | --- | --- |",
      "| brief: 2025-01-08 | 1 / 2 / 3 / 4 / 5 | |",
    ].join("\n"),
    "utf8",
  )
  if (withComparison) {
    await writeFile(
      join(runRoot, "comparison.md"),
      "# Ground-truth coverage comparison\n\n## Week 2025-01-08\n",
      "utf8",
    )
  }
}

function writeTimelineFixture(indexPath: string): void {
  const index = createSchoolIndex({ path: indexPath })
  try {
    index.applySnapshot({
      course: {
        canvasId: "course-17",
        name: "Strategy",
        courseCode: "STRAT 101",
        workflowState: "available",
        vaultPath: null,
      },
      assignments: [
        {
          canvasId: "assignment-7",
          courseCanvasId: "course-17",
          name: "Pricing memo",
          dueAt: "2025-01-08T17:00:00.000Z",
          vaultPath: null,
          allDates: [
            {
              canvasId: "base-date",
              dueAt: "2025-01-08T17:00:00.000Z",
              isUserOverride: false,
            },
            {
              canvasId: "override-date",
              dueAt: "2025-01-09T17:00:00.000Z",
              isUserOverride: true,
            },
          ],
          deleted: false,
        },
      ],
      syncRun: {
        canvasId: "sync-1",
        courseCanvasId: "course-17",
        startedAt: "2025-01-01T00:00:00.000Z",
        completedAt: "2025-01-01T00:01:00.000Z",
        status: "completed",
      },
    })
  } finally {
    index.close()
  }
}

async function writeConfig(directory: string): Promise<string> {
  const configPath = join(directory, "school.config.json")
  const vaultPath = join(directory, "vault")
  await writeFile(
    configPath,
    JSON.stringify({
      canvas: { baseUrl: "https://canvas.example.invalid" },
      vault: { path: vaultPath },
      index: { path: join(directory, "school.sqlite") },
    }),
    "utf8",
  )
  return configPath
}

describe("school gate m1 CLI", () => {
  it("packages a completed fixture run for the human ritual without scoring it", async () => {
    // Given: a completed local simulation, its comparison artifacts, and Canvas due-date overrides.
    const directory = await temporaryDirectory("school-agent-gate-m1-")
    const configPath = await writeConfig(directory)
    const vaultPath = join(directory, "vault")
    const evidencePath = join(directory, "evidence")
    await writeSimulationRun(vaultPath, "accepted-run", true)
    writeTimelineFixture(join(directory, "school.sqlite"))

    // When: the M1 gate packages the existing run without contacting Canvas.
    const result = await runSchool([
      "--config",
      configPath,
      "gate",
      "m1",
      "--run",
      "accepted-run",
      "--evidence",
      evidencePath,
    ])
    const bundle = await readFile(join(evidencePath, "gate-m1-bundle.md"), "utf8")

    // Then: all human-review components, including leakage and timeline evidence, remain unscored.
    expect(result.status).toBe(0)
    expect(bundle).toContain("## Simulation output index")
    expect(bundle).toContain("## comparison.md")
    expect(bundle).toContain("## Anchored human scorecard")
    expect(bundle).toContain("## Leakage report")
    expect(bundle).toContain("unknown-visibility: 2")
    expect(bundle).toContain("## Timeline-accuracy report")
    expect(bundle).toContain("## discrepancies.md")
    expect(bundle).toContain("2025-01-09T17:00:00.000Z")
    expect(bundle).toContain("No artifact below 3 and median >= 4")
    expect(bundle).toContain("Verdict: [ ] PASS  [ ] FAIL")
    expect(bundle).toContain("## Grounding report")
    expect(bundle).toContain("Vault sources — full text: 1, summary: 1, manifest: 1")
    expect(bundle).toContain("- (full text) assignments/pricing-memo.md")
    expect(bundle).toContain("- (summary) assignments/pricing-memo.md.summary.md")
    expect(bundle).toContain("- (manifest) _index.md")
    expect(bundle).toContain("The list price of $49 traces to assignments/pricing-memo.md.")
    expect(bundle).toContain(
      "The competitor benchmark figure is not present in any synced vault source.",
    )
    expect(bundle).toContain("- Grounding: every substantive claim in each draft traces")
    expect(bundle).toContain("## Visibility signal breakdown")
    expect(bundle).toContain("| module_release | 3 |")
    expect(bundle).toContain("| unknown | 2 |")
    expect(result.stdout).toContain("M1 ritual (~20 minutes):")
  })

  it("still packages a report.json written before the visibility field existed", async () => {
    // Given: an old-style report.json with no `visibility` field at all.
    const directory = await temporaryDirectory("school-agent-gate-m1-")
    const configPath = await writeConfig(directory)
    const vaultPath = join(directory, "vault")
    const evidencePath = join(directory, "evidence")
    await writeSimulationRun(vaultPath, "legacy-run", true, false)
    writeTimelineFixture(join(directory, "school.sqlite"))

    // When: the M1 gate packages that legacy run.
    const result = await runSchool([
      "--config",
      configPath,
      "gate",
      "m1",
      "--run",
      "legacy-run",
      "--evidence",
      evidencePath,
    ])
    const bundle = await readFile(join(evidencePath, "gate-m1-bundle.md"), "utf8")

    // Then: it still parses and packages successfully, disclosing the missing breakdown honestly
    // rather than fabricating counts.
    expect(result.status).toBe(0)
    expect(bundle).toContain("## Visibility signal breakdown")
    expect(bundle).toContain("No per-signal breakdown available (report.json predates this field).")
  })

  it("refuses an existing run when Todo 19 comparison output is missing", async () => {
    // Given: a completed fixture simulation without its required comparison artifact.
    const directory = await temporaryDirectory("school-agent-gate-m1-")
    const configPath = await writeConfig(directory)
    const vaultPath = join(directory, "vault")
    await writeSimulationRun(vaultPath, "missing-comparison", false)

    // When: the M1 gate is asked to package that incomplete run.
    const result = await runSchool([
      "--config",
      configPath,
      "gate",
      "m1",
      "--run",
      "missing-comparison",
    ])

    // Then: it refuses clearly instead of crashing or treating the run as comparable.
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("comparison.md is missing")
  })
})
