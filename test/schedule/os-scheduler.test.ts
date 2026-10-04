import { readFile } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"

import {
  getAutoPrepScheduleStatus,
  installAutoPrepSchedule,
  planAutoPrepSchedule,
  type SchedulerOptions,
  uninstallAutoPrepSchedule,
} from "../../src/schedule/os-scheduler.js"
import { temporaryDirectory } from "../helpers/tempDir.js"

function options(homeDir: string, platform: "darwin" | "linux"): SchedulerOptions {
  return {
    platform,
    homeDir,
    uid: 501,
    label: "com.school-agent.auto-prep",
    nodePath: "/opt/Node & More/bin/node",
    scriptPath: "/opt/school agent/school.js",
    configPath: "/Users/Student & Co/config 100%.json",
  }
}

describe("OS auto-prep scheduler", () => {
  it("renders a safe hourly launchd agent with fixed execute argv", () => {
    const plan = planAutoPrepSchedule(options("/Users/Student", "darwin"))
    expect(plan.files[0].path).toBe(
      "/Users/Student/Library/LaunchAgents/com.school-agent.auto-prep.plist",
    )
    expect(plan.files[0].content).toContain(
      "<key>StartCalendarInterval</key><dict><key>Minute</key><integer>0</integer></dict>",
    )
    expect(plan.files[0].content).toContain(
      "<string>/Users/Student &amp; Co/config 100%.json</string>",
    )
    expect(plan.files[0].content).toContain(
      "<string>auto-prep</string>\n<string>run</string>\n<string>--execute</string>",
    )
    expect(plan.activate).toEqual([
      { executable: "launchctl", args: ["bootstrap", "gui/501", plan.files[0].path] },
    ])
    expect(plan.deactivate[0].args).toEqual(["bootout", "gui/501/com.school-agent.auto-prep"])
  })

  it("renders a user systemd timer and quotes paths without expansion", () => {
    const plan = planAutoPrepSchedule({
      ...options("/home/student", "linux"),
      configPath: '/home/student/100% $SAVE "this".json',
    })
    expect(plan.files.map((file) => file.path)).toEqual([
      "/home/student/.config/systemd/user/com.school-agent.auto-prep.service",
      "/home/student/.config/systemd/user/com.school-agent.auto-prep.timer",
    ])
    expect(plan.files[0].content).toContain('"/home/student/100%% $$SAVE \\"this\\".json"')
    expect(plan.files[0].content).toContain('"auto-prep" "run" "--execute"')
    expect(plan.files[1].content).toContain("OnCalendar=hourly\nPersistent=true")
    expect(plan.activate[1].args).toEqual([
      "--user",
      "enable",
      "--now",
      "com.school-agent.auto-prep.timer",
    ])
  })

  it("keeps installation and removal dry-run by default", async () => {
    const homeDir = await temporaryDirectory("scheduler-dry-run-")
    const input = options(homeDir, process.platform === "darwin" ? "darwin" : "linux")
    const run = vi.fn(async () => ({ exitCode: 0 }))
    expect((await installAutoPrepSchedule(input, { run })).applied).toBe(false)
    expect((await uninstallAutoPrepSchedule(input, { run })).applied).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect((await getAutoPrepScheduleStatus(input, run)).installed).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("applies and uninstalls only owned files with an injected command runner", async () => {
    const homeDir = await temporaryDirectory("scheduler-apply-")
    const platform = process.platform === "darwin" ? "darwin" : "linux"
    const input = options(homeDir, platform)
    const run = vi.fn(async (command: { args: string[] }) => ({
      exitCode: command.args.includes("print") || command.args.includes("is-active") ? 1 : 0,
    }))
    const installed = await installAutoPrepSchedule(input, { apply: true, run })
    expect(installed.applied).toBe(true)
    for (const file of installed.plan.files)
      expect(await readFile(file.path, "utf8")).toBe(file.content)
    await uninstallAutoPrepSchedule(input, { apply: true, run })
    const status = await getAutoPrepScheduleStatus(input, run)
    expect(status.installed).toBe(false)
  })

  it("rejects relative paths and unsafe labels", () => {
    expect(() =>
      planAutoPrepSchedule({ ...options("/home/student", "linux"), nodePath: "node" }),
    ).toThrow("nodePath")
    expect(() =>
      planAutoPrepSchedule({ ...options("/home/student", "linux"), label: "../other" }),
    ).toThrow("label")
  })
})
