import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"
import { CanvasHttpClient } from "../src/canvas/http.js"
import { runCli } from "../src/cli.js"
import { loadConfig } from "../src/config/index.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

describe("auto-prep configuration commands", () => {
  it("keeps prep disabled until explicit opt-in and saves confirmed meeting/standing", async () => {
    const root = await temporaryDirectory("auto-prep-config-")
    const configPath = join(root, "school.config.json")
    await writeFile(
      configPath,
      JSON.stringify({
        vault: { path: join(root, "vault") },
        index: { path: join(root, "index.db") },
      }),
    )
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      expect(loadConfig(configPath).autoPrep.enabled).toBe(false)
      expect(
        await runCli(["--config", configPath, "schedule", "set-standing", "101", "waitlisted"]),
      ).toBe(0)
      expect(
        await runCli([
          "--config",
          configPath,
          "schedule",
          "add-meeting",
          "101",
          "--days",
          "mon,wed",
          "--time",
          "10:00",
          "--from",
          "2026-09-21",
          "--until",
          "2026-12-09",
        ]),
      ).toBe(0)
      expect(loadConfig(configPath).autoPrep).toMatchObject({
        enabled: false,
        standingOverrides: { "101": "waitlisted" },
        meetings: [{ courseCanvasId: "101", daysOfWeek: [1, 3], localTime: "10:00" }],
      })
      expect(
        await runCli([
          "--config",
          configPath,
          "auto-prep",
          "configure",
          "--enable",
          "--timezone",
          "America/Los_Angeles",
        ]),
      ).toBe(0)
      expect(loadConfig(configPath).autoPrep).toMatchObject({
        enabled: true,
        timeZone: "America/Los_Angeles",
      })
      expect(await runCli(["--config", configPath, "schedule", "clear-standing", "101"])).toBe(0)
      expect(loadConfig(configPath).autoPrep.standingOverrides).toEqual({})
      expect(await runCli(["--config", configPath, "schedule", "remove-meeting", "1"])).toBe(0)
      expect(loadConfig(configPath).autoPrep.meetings).toEqual([])
      expect(JSON.parse(await readFile(configPath, "utf8"))).toHaveProperty("vault")
    } finally {
      log.mockRestore()
    }
  })

  it("lists only enrolled upcoming meetings unless --all is requested", async () => {
    vi.stubEnv("CANVAS_TOKEN", "synthetic-token")
    const root = await temporaryDirectory("auto-prep-list-")
    const configPath = join(root, "school.config.json")
    await writeFile(
      configPath,
      JSON.stringify({
        vault: { path: join(root, "vault") },
        index: { path: join(root, "index.db") },
        autoPrep: {
          timeZone: "UTC",
          standingOverrides: { "202": "waitlisted" },
          meetings: ["101", "202"].map((courseCanvasId) => ({
            courseCanvasId,
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            localTime: "23:59",
            startsOn: "2020-01-01",
            endsOn: "2100-12-31",
          })),
        },
      }),
    )
    const paginate = vi
      .spyOn(CanvasHttpClient.prototype, "paginate")
      .mockImplementation(async function* (path) {
        if (path.startsWith("/api/v1/users/self/enrollments")) {
          yield new Response(
            JSON.stringify([
              { course_id: 101, enrollment_state: "active", type: "StudentEnrollment" },
              { course_id: 202, enrollment_state: "active", type: "StudentEnrollment" },
            ]),
          )
        }
      })
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      expect(await runCli(["--config", configPath, "schedule", "list", "--days", "1"])).toBe(0)
      const normal = log.mock.calls.map((call) => String(call[0])).join("\n")
      expect(normal).toContain("\t101\tenrolled")
      expect(normal).not.toContain("\t202\twaitlisted")
      log.mockClear()
      expect(
        await runCli(["--config", configPath, "schedule", "list", "--days", "1", "--all"]),
      ).toBe(0)
      expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "\t202\twaitlisted",
      )
    } finally {
      log.mockRestore()
      paginate.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})
