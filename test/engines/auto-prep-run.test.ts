import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { SchoolConfig } from "../../src/config/index.js"
import { runAutoPrep } from "../../src/engines/auto-prep-run.js"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const autoPrep: SchoolConfig["autoPrep"] = {
  enabled: true,
  timeZone: "America/Los_Angeles",
  leadHours: 24,
  windowHours: 24,
  standingOverrides: {},
  meetings: [
    {
      courseCanvasId: "42",
      daysOfWeek: [1],
      localTime: "10:00",
      startsOn: "2026-09-28",
      endsOn: "2026-09-28",
    },
  ],
}

function client(state = "active", onPath?: (path: string) => void) {
  return {
    async *paginate(path: string) {
      onPath?.(path)
      yield new Response(
        JSON.stringify(
          path.startsWith("/api/v1/users/self/enrollments")
            ? [{ course_id: 42, enrollment_state: state, type: "StudentEnrollment" }]
            : [],
        ),
      )
    },
  }
}

async function vaultPath() {
  const root = await mkdtemp(join(tmpdir(), "auto-prep-run-"))
  roots.push(root)
  return join(root, "vault")
}

describe("automatic prep runner", () => {
  it.each([
    ["America/Los_Angeles", "2026-10-09T09:00:00-07:00"],
    ["Pacific/Kiritimati", "2026-10-09T09:00:00+14:00"],
    ["America/New_York", "2026-11-06T09:00:00-05:00"],
  ])("does not revive expired Monday prep on Friday in %s", async (timeZone, now) => {
    const vaultRoot = await vaultPath()
    let prepared = 0
    const report = await runAutoPrep({
      client: client(),
      config: {
        autoPrep: {
          ...autoPrep,
          timeZone,
          meetings: [
            {
              courseCanvasId: "42",
              daysOfWeek: [1, 5],
              localTime: "09:00",
              startsOn: "2026-10-01",
              endsOn: "2026-11-30",
            },
          ],
        },
      },
      vaultRoot,
      now,
      execute: true,
      prepare: async () => {
        prepared++
      },
      hasExistingPrep: async () => false,
    })
    expect(report.plan.jobs).toEqual([])
    expect(report.plan.skipped.some((item) => item.reason === "expired")).toBe(true)
    expect(report.plan.skipped.some((item) => item.reason === "duplicate-week")).toBe(true)
    expect(prepared).toBe(0)
    await expect(access(vaultRoot)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([
    ["America/Los_Angeles", "2026-10-04T09:00:00-07:00"],
    ["Pacific/Kiritimati", "2026-10-04T09:00:00+14:00"],
  ])("previews next Monday's week at its Sunday due boundary in %s", async (timeZone, now) => {
    const report = await runAutoPrep({
      client: client(),
      config: {
        autoPrep: {
          ...autoPrep,
          timeZone,
          meetings: [
            {
              courseCanvasId: "42",
              daysOfWeek: [1, 5],
              localTime: "09:00",
              startsOn: "2026-09-28",
              endsOn: "2026-10-09",
            },
          ],
        },
      },
      vaultRoot: await vaultPath(),
      now,
      prepare: async () => {
        throw new Error("Preview must not generate")
      },
      hasExistingPrep: async () => false,
    })
    expect(report.outcomes).toHaveLength(1)
    expect(report.outcomes[0]).toMatchObject({
      status: "would-run",
      job: { weekStart: "2026-10-05", dueAt: new Date(now).toISOString() },
    })
  })

  it("previews a due confirmed meeting without writing or preparing", async () => {
    const vaultRoot = await vaultPath()
    let prepared = 0
    const requestedPaths: string[] = []
    const report = await runAutoPrep({
      client: client("active", (path) => requestedPaths.push(path)),
      config: { autoPrep },
      vaultRoot,
      now: "2026-09-27T17:00:00Z",
      prepare: async () => {
        prepared++
      },
      hasExistingPrep: async () => false,
    })
    expect(report.mode).toBe("preview")
    expect(report.outcomes.map((outcome) => outcome.status)).toEqual(["would-run"])
    expect(prepared).toBe(0)
    expect(requestedPaths).toHaveLength(1)
    expect(requestedPaths[0]).toContain("/api/v1/users/self/enrollments")
    await expect(access(vaultRoot)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("executes once and leaves a durable completed ledger", async () => {
    const vaultRoot = await vaultPath()
    let prepared = 0
    const input = {
      client: client(),
      config: { autoPrep },
      vaultRoot,
      now: "2026-09-27T17:00:00Z",
      prepare: async () => {
        prepared++
      },
      hasExistingPrep: async () => false,
      execute: true,
    }
    const first = await runAutoPrep(input)
    const second = await runAutoPrep(input)
    expect(first.outcomes.map((outcome) => outcome.status)).toEqual(["completed"])
    expect(second.outcomes.map((outcome) => outcome.status)).toEqual(["already-attempted"])
    expect(prepared).toBe(1)
    const ledgerPath = first.outcomes[0]?.ledgerPath
    expect(ledgerPath).toBeDefined()
    expect(JSON.parse(await readFile(ledgerPath ?? "", "utf8")).status).toBe("completed")
  })

  it("does not prepare twice when two invocations overlap", async () => {
    const vaultRoot = await vaultPath()
    let prepared = 0
    const input = {
      client: client(),
      config: { autoPrep },
      vaultRoot,
      now: "2026-09-27T17:00:00Z",
      prepare: async () => {
        prepared++
        await new Promise((resolve) => setTimeout(resolve, 20))
      },
      hasExistingPrep: async () => false,
      execute: true,
    }
    const reports = await Promise.all([runAutoPrep(input), runAutoPrep(input)])
    expect(prepared).toBe(1)
    expect(reports.flatMap((report) => report.outcomes.map((outcome) => outcome.status))).toContain(
      "completed",
    )
  })

  it("skips existing prep and unknown or unavailable enrollment", async () => {
    const vaultRoot = await vaultPath()
    let prepared = 0
    const base = {
      config: { autoPrep },
      vaultRoot,
      now: "2026-09-27T17:00:00Z",
      execute: true,
      prepare: async () => {
        prepared++
      },
    }
    const existing = await runAutoPrep({
      ...base,
      client: client(),
      hasExistingPrep: async () => true,
    })
    const unknown = await runAutoPrep({
      ...base,
      client: client("invited"),
      hasExistingPrep: async () => false,
    })
    expect(existing.outcomes.map((outcome) => outcome.status)).toEqual(["existing-prep"])
    expect(unknown.plan.jobs).toEqual([])
    expect(prepared).toBe(0)
  })

  it("records failed attempts and suppresses automatic retry", async () => {
    const vaultRoot = await vaultPath()
    let attempts = 0
    const base = {
      client: client(),
      config: { autoPrep },
      vaultRoot,
      now: "2026-09-27T17:00:00Z",
      prepare: async () => {
        attempts++
        throw new Error("synthetic failure")
      },
      hasExistingPrep: async () => false,
      execute: true,
    }
    const first = await runAutoPrep(base)
    const second = await runAutoPrep(base)
    expect(first.outcomes[0]?.status).toBe("failed")
    expect(second.outcomes[0]?.status).toBe("already-attempted")
    expect(second.outcomes[0]?.ledgerStatus).toBe("failed")
    expect(first.outcomes[0]?.errorSummary).toContain("Preparation failed: Error")
    expect(second.outcomes[0]?.errorSummary).toBe(first.outcomes[0]?.errorSummary)
    expect(attempts).toBe(1)
  })
})
