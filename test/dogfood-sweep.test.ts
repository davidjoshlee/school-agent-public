import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import { runDogfoodSweep } from "../src/engines/dogfood-sweep.js"
import { resolveDogfoodSessions } from "../src/engines/dogfood-sweep-resolve.js"
import {
  type DogfoodFlow,
  DogfoodFlowSkip,
  type DogfoodSweepSession,
} from "../src/engines/dogfood-types.js"
import { assignmentPaths, coursePaths, dogfoodSweepPaths } from "../src/store/paths.js"
import { renderVaultDocument } from "../src/store/vault.js"
import { createVaultFrontmatter } from "../src/store/vault-document.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

const course = { code: "ACCT 213", canvasId: "201" } as const

async function put(
  path: string,
  canvasId: string,
  content: string,
  dates: Readonly<Record<string, string>> = {},
  type = "fixture",
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    renderVaultDocument(
      createVaultFrontmatter({
        canvasId,
        canvasUrl: `https://canvas.example.invalid/${canvasId}`,
        type,
        content,
        dates,
        source: "sync",
        status: "final",
        aiPolicy: "allowed",
      }),
      content,
    ),
    "utf8",
  )
}

/** Three sessions, deliberately synced/directory-ordered out of session-number
 * order: session 2's module directory sorts before session 1's. Session 3 is
 * prep-only (no Assignment item). */
async function threeSessionVault(): Promise<string> {
  const root = await temporaryDirectory("school-agent-dogfood-sweep-")
  const paths = coursePaths(root, course.code, course.canvasId)
  const assignmentPath = (title: string): string => assignmentPaths(paths, { title }).prompt

  await put(
    join(paths.root, "Week 02 - Oct 02", "00 Overview.md"),
    "702m",
    ["Session 2 - October 2 - Ethics", "", "- Assignment: Ethics Memo (canvas_id: 702)"].join("\n"),
    {},
    "module",
  )
  await put(assignmentPath("Ethics Memo"), "702", "Ethics memo prompt.", {}, "assignments")

  await put(
    join(paths.root, "Week 01 - Sep 25", "00 Overview.md"),
    "701m",
    ["Session 1 - September 25 - Intro", "", "- Assignment: Intro Memo (canvas_id: 701)"].join(
      "\n",
    ),
    { unlock_at: "2025-09-25T00:00:00.000Z" },
    "module",
  )
  await put(assignmentPath("Intro Memo"), "701", "Intro memo prompt.", {}, "assignments")

  await put(
    join(paths.root, "Week 03 - Oct 09", "00 Overview.md"),
    "703m",
    ["Session 3 - Review", "", "- File: Review Slides"].join("\n"),
    { unlock_at: "2025-10-09T00:00:00.000Z" },
    "module",
  )

  return root
}

function fakeFlow(name: string, behavior: "pass" | "fail" | "skip", calls: string[]): DogfoodFlow {
  return {
    name,
    kind: "auto",
    async run() {
      calls.push(name)
      if (behavior === "fail") throw new Error(`${name} exploded`)
      if (behavior === "skip") throw new DogfoodFlowSkip("no draftable assignment this session")
      return { evidence: `${name}-evidence` }
    },
  }
}

describe("resolveDogfoodSessions", () => {
  it("orders sessions by session number (not directory order) and resolves date + assignment", async () => {
    const root = await threeSessionVault()
    const courseRoot = coursePaths(root, course.code, course.canvasId).root

    const sessions = await resolveDogfoodSessions(courseRoot, 5)

    expect(sessions.map((session) => session.sessionNumber)).toEqual([1, 2, 3])
    expect(sessions[0]).toMatchObject({ weekDate: "2025-09-25", assignmentId: "701" })
    // Session 2 has no unlock_at of its own; year is inferred from session 1's.
    expect(sessions[1]).toMatchObject({ weekDate: "2025-10-02", assignmentId: "702" })
    // Session 3 is prep-only: no Assignment item.
    expect(sessions[2]).toMatchObject({ weekDate: "2025-10-09", assignmentId: null })
  })

  it("caps the resolved list at the requested count", async () => {
    const root = await threeSessionVault()
    const courseRoot = coursePaths(root, course.code, course.canvasId).root

    const sessions = await resolveDogfoodSessions(courseRoot, 2)

    expect(sessions.map((session) => session.sessionNumber)).toEqual([1, 2])
  })
})

describe("runDogfoodSweep", () => {
  const sessions: readonly DogfoodSweepSession[] = [
    { sessionNumber: 1, title: "Session 1", weekDate: "2025-09-25", assignmentId: "701" },
    { sessionNumber: 2, title: "Session 2", weekDate: "2025-10-02", assignmentId: null },
  ]

  it("writes distinct, non-clobbering per-session files plus one aggregate index", async () => {
    const vaultRoot = await temporaryDirectory("school-agent-dogfood-sweep-run-")
    const courseSlug = "acct-213-201"
    const calls: string[] = []

    const index = await runDogfoodSweep({
      course: "201",
      courseSlug,
      vaultRoot,
      sessions,
      log: () => {},
      buildFlows: (session) =>
        session.assignmentId === null
          ? [fakeFlow("sync", "pass", calls), fakeFlow("draft (no guidance)", "skip", calls)]
          : [fakeFlow("sync", "pass", calls), fakeFlow("draft (no guidance)", "pass", calls)],
    })

    const expectedPaths = dogfoodSweepPaths(vaultRoot, courseSlug)
    const session1Results = expectedPaths.sessionResultsPath(1, "2025-09-25")
    const session2Results = expectedPaths.sessionResultsPath(2, "2025-10-02")
    expect(session1Results).not.toBe(session2Results)

    const session1Json = JSON.parse(await readFile(session1Results, "utf8"))
    const session2Json = JSON.parse(await readFile(session2Results, "utf8"))
    expect(session1Json.flows.map((flow: { status: string }) => flow.status)).toEqual([
      "pass",
      "pass",
    ])
    expect(session2Json.flows.map((flow: { status: string }) => flow.status)).toEqual([
      "pass",
      "skipped",
    ])

    // Prep-only session: skipped counts as not-failed, never a bogus pass.
    expect(index.entries[1]).toMatchObject({ passed: 1, skipped: 1, total: 2, failed: false })
    expect(index.entries[0]).toMatchObject({ passed: 2, skipped: 0, total: 2, failed: false })

    const indexJsonPath = expectedPaths.indexPath(index.startedAt.slice(0, 10))
    const indexMdPath = expectedPaths.indexSummaryPath(index.startedAt.slice(0, 10))
    const persistedIndex = JSON.parse(await readFile(indexJsonPath, "utf8"))
    expect(persistedIndex.entries).toHaveLength(2)
    expect(persistedIndex.courseSlug).toBe(courseSlug)
    const summaryMd = await readFile(indexMdPath, "utf8")
    expect(summaryMd).toContain("# Dogfood sweep")
    expect(summaryMd).toContain("(prep-only)")
  })

  it("isolates a session-building failure: the rest of the sweep still runs", async () => {
    const vaultRoot = await temporaryDirectory("school-agent-dogfood-sweep-isolation-")
    const threeSessions: readonly DogfoodSweepSession[] = [
      { sessionNumber: 1, title: "Session 1", weekDate: "2025-09-25", assignmentId: "701" },
      { sessionNumber: 2, title: "Session 2", weekDate: "2025-10-02", assignmentId: "702" },
      { sessionNumber: 3, title: "Session 3", weekDate: "2025-10-09", assignmentId: "703" },
    ]
    const calls: string[] = []

    const index = await runDogfoodSweep({
      course: "201",
      courseSlug: "acct-213-201",
      vaultRoot,
      sessions: threeSessions,
      log: () => {},
      buildFlows: (session) => {
        if (session.sessionNumber === 2) {
          throw new Error("module resolution exploded")
        }
        return [fakeFlow("sync", "pass", calls)]
      },
    })

    expect(index.entries).toHaveLength(3)
    expect(index.entries[0]).toMatchObject({ failed: false })
    expect(index.entries[1]).toMatchObject({ failed: true, error: "module resolution exploded" })
    expect(index.entries[2]).toMatchObject({ failed: false })
    // Session 1 and session 3 both ran despite session 2's failure.
    expect(calls).toEqual(["sync", "sync"])
  })

  it("resumes by skipping a session whose result file already shows all-not-failed", async () => {
    const vaultRoot = await temporaryDirectory("school-agent-dogfood-sweep-resume-")
    const courseSlug = "acct-213-201"
    const firstCalls: string[] = []

    await runDogfoodSweep({
      course: "201",
      courseSlug,
      vaultRoot,
      sessions,
      log: () => {},
      buildFlows: (session) =>
        session.assignmentId === null
          ? [
              fakeFlow("sync", "pass", firstCalls),
              fakeFlow("draft (no guidance)", "skip", firstCalls),
            ]
          : [
              fakeFlow("sync", "pass", firstCalls),
              fakeFlow("draft (no guidance)", "pass", firstCalls),
            ],
    })

    const secondCalls: string[] = []
    const rerunIndex = await runDogfoodSweep({
      course: "201",
      courseSlug,
      vaultRoot,
      sessions,
      log: () => {},
      buildFlows: () => {
        throw new Error("buildFlows must not be called for an already not-failed session")
      },
    })

    // Neither session's buildFlows ran a second time: both were already
    // not-failed (session 1 all-pass, session 2 pass+skipped).
    expect(secondCalls).toEqual([])
    expect(rerunIndex.entries).toMatchObject([
      { passed: 2, skipped: 0, total: 2, failed: false },
      { passed: 1, skipped: 1, total: 2, failed: false },
    ])
  })

  it("--fresh reruns every session even when previously all not-failed", async () => {
    const vaultRoot = await temporaryDirectory("school-agent-dogfood-sweep-fresh-")
    const courseSlug = "acct-213-201"
    const firstCalls: string[] = []

    await runDogfoodSweep({
      course: "201",
      courseSlug,
      vaultRoot,
      sessions: [sessions[0] as DogfoodSweepSession],
      log: () => {},
      buildFlows: () => [fakeFlow("sync", "pass", firstCalls)],
    })

    const secondCalls: string[] = []
    await runDogfoodSweep({
      course: "201",
      courseSlug,
      vaultRoot,
      sessions: [sessions[0] as DogfoodSweepSession],
      fresh: true,
      log: () => {},
      buildFlows: () => [fakeFlow("sync", "pass", secondCalls)],
    })

    expect(secondCalls).toEqual(["sync"])
  })
})
