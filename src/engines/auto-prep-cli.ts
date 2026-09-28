import { isAbsolute, resolve } from "node:path"

import type { Command } from "commander"

import { discoverCourseSchedule } from "../canvas/course-schedule.js"
import { CanvasHttpClient } from "../canvas/http.js"
import { listDiscoveredCourses } from "../canvas/onboard.js"
import { loadConfig, updateAutoPrepConfig } from "../config/index.js"
import {
  getAutoPrepScheduleStatus,
  installAutoPrepSchedule,
  type SchedulerOptions,
  uninstallAutoPrepSchedule,
} from "../schedule/os-scheduler.js"
import { generateScheduledPrep, hasExistingWeeklyPrep } from "./auto-prep-generate.js"
import { runAutoPrep } from "./auto-prep-run.js"
import { expandConfirmedMeetings } from "./meeting-recurrence.js"

type RootOptions = { readonly config: string }
const standingValues = new Set(["enrolled", "waitlisted", "old"])
const weekdayNames: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

export function registerAutoPrepCommand(program: Command): void {
  const schedule = program.command("schedule").description("Inspect and confirm class meetings")
  const list = schedule
    .command("list")
    .description("Show upcoming confirmed meetings for currently enrolled courses")
    .option("--days <number>", "look-ahead window", "14")
    .option("--all", "also show waitlisted, old, and unknown course meetings")
  list.action(async () => {
    const configuration = loadConfig(program.opts<RootOptions>().config)
    const options = list.opts<{ days: string; all?: boolean }>()
    const days = boundedInteger(options.days, 1, 90, "days")
    const today = localDate(new Date(), configuration.autoPrep.timeZone)
    const end = addUtcDays(today, days)
    const meetings = expandConfirmedMeetings(
      configuration.autoPrep.meetings,
      configuration.autoPrep.timeZone,
      today,
      end,
    )
    const client = new CanvasHttpClient({
      baseUrl: configuration.canvas.baseUrl,
      tokenEnv: configuration.canvas.tokenEnv,
    })
    const discovery = await discoverCourseSchedule(client, {
      courseIds: [...new Set(configuration.autoPrep.meetings.map((rule) => rule.courseCanvasId))],
      startDate: today,
      endDate: end,
      designations: configuration.autoPrep.standingOverrides,
      includeCalendar: false,
    })
    const standing = new Map(discovery.courses.map((course) => [course.courseId, course.standing]))
    console.log(
      `Confirmed meetings (${configuration.autoPrep.timeZone}); enrollment=${discovery.enrollmentCoverage}.`,
    )
    for (const meeting of meetings) {
      if (Date.parse(meeting.startsAt) < Date.now()) continue
      const status =
        discovery.enrollmentCoverage === "available"
          ? (standing.get(meeting.courseCanvasId) ?? "unknown")
          : "unknown"
      if (options.all !== true && status !== "enrolled") continue
      const localStart = new Intl.DateTimeFormat("en-US", {
        timeZone: configuration.autoPrep.timeZone,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(meeting.startsAt))
      console.log(`${localStart}\t${meeting.courseCanvasId}\t${status}`)
    }
  })
  const discover = schedule
    .command("discover")
    .description("Show Canvas enrollment and unconfirmed calendar candidates (read-only)")
    .option("--course <canvas-id>", "include a course not yet allowlisted")
    .option("--days <number>", "calendar look-ahead", "14")
    .option("--json", "print the local report as JSON")
  discover.action(async () => {
    const configuration = loadConfig(program.opts<RootOptions>().config)
    const options = discover.opts<{ course?: string; days: string; json?: boolean }>()
    const days = boundedInteger(options.days, 1, 90, "days")
    const client = new CanvasHttpClient({
      baseUrl: configuration.canvas.baseUrl,
      tokenEnv: configuration.canvas.tokenEnv,
    })
    const discovered = await listDiscoveredCourses(client)
    const ids = [
      ...new Set([
        ...discovered.map((course) => course.id),
        ...configuration.courses.allowlist,
        ...Object.keys(configuration.autoPrep.standingOverrides),
        ...configuration.autoPrep.meetings.map((meeting) => meeting.courseCanvasId),
        ...(options.course === undefined ? [] : [options.course]),
      ]),
    ]
    const today = localDate(new Date(), configuration.autoPrep.timeZone)
    const report = await discoverCourseSchedule(client, {
      courseIds: ids,
      startDate: today,
      endDate: addUtcDays(today, days),
      designations: configuration.autoPrep.standingOverrides,
    })
    if (options.json === true) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    console.log("Canvas calendar entries are candidates, not confirmed class meetings.")
    for (const course of report.courses) {
      const name = discovered.find((item) => item.id === course.courseId)?.code ?? course.courseId
      console.log(`${course.courseId}\t${course.standing}\t${name}\t${course.source}`)
    }
    for (const event of report.events) {
      console.log(`candidate\t${event.courseId}\t${event.startAt}\t${event.title}`)
    }
    console.log(
      `Enrollment: ${report.enrollmentCoverage}; skipped calendar entries: ${report.skippedCalendarEvents}`,
    )
  })

  schedule
    .command("set-standing <canvas-id> <enrolled|waitlisted|old>")
    .description("Explicitly designate a course's current standing")
    .action((courseId: string, standing: string) => {
      if (!standingValues.has(standing))
        throw new Error("Standing must be enrolled, waitlisted, or old")
      updateAutoPrepConfig(program.opts<RootOptions>().config, (current) => ({
        ...current,
        standingOverrides: {
          ...current.standingOverrides,
          [courseId]: standing as "enrolled" | "waitlisted" | "old",
        },
      }))
      console.log(
        `Saved ${courseId} as ${standing}. Review this designation when enrollment changes.`,
      )
    })

  schedule
    .command("clear-standing <canvas-id>")
    .description("Remove a manual standing designation and use Canvas evidence")
    .action((courseId: string) => {
      updateAutoPrepConfig(program.opts<RootOptions>().config, (current) => {
        const standingOverrides = { ...current.standingOverrides }
        delete standingOverrides[courseId]
        return { ...current, standingOverrides }
      })
      console.log(`Cleared manual standing for ${courseId}.`)
    })

  const add = schedule
    .command("add-meeting <canvas-id>")
    .description("Confirm a recurring class meeting for automatic prep")
    .requiredOption("--days <mon,wed>", "comma-separated weekdays")
    .requiredOption("--time <HH:mm>", "local class start time")
    .requiredOption("--from <YYYY-MM-DD>", "first date")
    .requiredOption("--until <YYYY-MM-DD>", "last date")
  add.action((courseId: string) => {
    const options = add.opts<{ days: string; time: string; from: string; until: string }>()
    const daysOfWeek = [
      ...new Set(
        options.days
          .toLowerCase()
          .split(",")
          .map((day) => {
            const result = weekdayNames[day.trim()]
            if (result === undefined) throw new Error(`Unknown weekday: ${day}`)
            return result
          }),
      ),
    ]
    const rule = {
      courseCanvasId: courseId,
      daysOfWeek,
      localTime: options.time,
      startsOn: options.from,
      endsOn: options.until,
    }
    updateAutoPrepConfig(program.opts<RootOptions>().config, (current) => ({
      ...current,
      meetings: [...current.meetings, rule],
    }))
    console.log(`Confirmed recurring meeting for ${courseId}; automatic prep remains opt-in.`)
  })

  schedule
    .command("rules")
    .description("List confirmed recurring meeting rules and their removal numbers")
    .action(() => {
      const configuration = loadConfig(program.opts<RootOptions>().config)
      console.log(`Time zone: ${configuration.autoPrep.timeZone}`)
      configuration.autoPrep.meetings.forEach((rule, index) => {
        console.log(
          `${index + 1}\t${rule.courseCanvasId}\t${rule.daysOfWeek.join(",")}\t${rule.localTime}\t${rule.startsOn}..${rule.endsOn}`,
        )
      })
    })

  schedule
    .command("remove-meeting <number>")
    .description("Remove one numbered recurring rule shown by schedule rules")
    .action((number: string) => {
      updateAutoPrepConfig(program.opts<RootOptions>().config, (current) => {
        const index = boundedInteger(number, 1, current.meetings.length, "meeting number") - 1
        return {
          ...current,
          meetings: current.meetings.filter((_, position) => position !== index),
        }
      })
      console.log(`Removed recurring meeting rule ${number}.`)
    })

  const autoPrep = program.command("auto-prep").description("Plan and run scheduled class prep")
  const run = autoPrep
    .command("run")
    .description("Preview due prep; --execute generates only new confirmed enrolled-course briefs")
    .option("--execute", "generate due prep and record a durable attempt")
    .option("--json", "print the local run report as JSON")
  run.action(async () => {
    const config = loadConfig(program.opts<RootOptions>().config)
    const json = run.opts<{ json?: boolean }>().json === true
    const client = new CanvasHttpClient({
      baseUrl: config.canvas.baseUrl,
      tokenEnv: config.canvas.tokenEnv,
    })
    const report = await runAutoPrep({
      client,
      config,
      vaultRoot: config.vault.path,
      now: new Date(),
      execute: run.opts<{ execute?: boolean }>().execute === true,
      prepare: async (courseId, weekStart) => {
        const path = await generateScheduledPrep(config, courseId, weekStart)
        if (!json) console.log(`Prepared ${courseId} week ${weekStart}: ${path}`)
      },
      hasExistingPrep: (courseId, weekStart) => hasExistingWeeklyPrep(config, courseId, weekStart),
    })
    if (json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(
        `Auto-prep ${report.mode}: ${report.plan.jobs.length} due job(s); enrollment=${report.enrollmentCoverage}.`,
      )
      for (const outcome of report.outcomes) {
        console.log(`${outcome.job.courseCanvasId}\t${outcome.job.weekStart}\t${outcome.status}`)
      }
    }
    if (report.outcomes.some((outcome) => outcome.status === "failed")) {
      throw new Error(
        "One or more automatic prep jobs failed; inspect the local ledger before retrying",
      )
    }
  })
  const configure = autoPrep
    .command("configure")
    .description("Set automatic prep policy (disabled until enabled explicitly)")
    .option("--enable", "enable automatic prep")
    .option("--disable", "disable automatic prep")
    .option("--timezone <iana-zone>", "class schedule time zone")
    .option("--lead-hours <number>", "hours before first weekly meeting", "")
    .option("--window-hours <number>", "late catch-up window", "")
  configure.action(() => {
    const options = configure.opts<{
      enable?: boolean
      disable?: boolean
      timezone?: string
      leadHours: string
      windowHours: string
    }>()
    if (options.enable === true && options.disable === true)
      throw new Error("Choose --enable or --disable")
    const next = updateAutoPrepConfig(program.opts<RootOptions>().config, (current) => ({
      ...current,
      enabled: options.enable === true ? true : options.disable === true ? false : current.enabled,
      timeZone: options.timezone ?? current.timeZone,
      leadHours:
        options.leadHours === ""
          ? current.leadHours
          : boundedInteger(options.leadHours, 1, 168, "lead-hours"),
      windowHours:
        options.windowHours === ""
          ? current.windowHours
          : boundedInteger(options.windowHours, 1, 48, "window-hours"),
    }))
    console.log(
      `Automatic prep ${next.enabled ? "enabled" : "disabled"}; timezone=${next.timeZone}; lead=${next.leadHours}h; window=${next.windowHours}h.`,
    )
  })

  const install = autoPrep
    .command("install")
    .description("Plan or install an hourly OS job; defaults to dry-run")
    .option("--apply", "write and activate the OS job")
  install.action(async () => {
    const configuration = loadConfig(program.opts<RootOptions>().config)
    if (!configuration.autoPrep.enabled)
      throw new Error("Enable auto-prep before installing its job")
    const options = schedulerOptions(program.opts<RootOptions>().config)
    const result = await installAutoPrepSchedule(options, {
      apply: install.opts<{ apply?: boolean }>().apply === true,
    })
    console.log(`${result.applied ? "Installed" : "Dry-run"} ${result.plan.platform} hourly job:`)
    for (const file of result.plan.files) console.log(file.path)
  })

  const uninstall = autoPrep
    .command("uninstall")
    .description("Plan or remove the owned hourly OS job; defaults to dry-run")
    .option("--apply", "stop and remove the OS job")
  uninstall.action(async () => {
    const result = await uninstallAutoPrepSchedule(
      schedulerOptions(program.opts<RootOptions>().config),
      {
        apply: uninstall.opts<{ apply?: boolean }>().apply === true,
      },
    )
    console.log(`${result.applied ? "Removed" : "Dry-run"} ${result.plan.platform} hourly job.`)
  })

  autoPrep
    .command("status")
    .description("Show configured policy and OS job status")
    .action(async () => {
      const configuration = loadConfig(program.opts<RootOptions>().config)
      const status = await getAutoPrepScheduleStatus(
        schedulerOptions(program.opts<RootOptions>().config),
      )
      console.log(
        `enabled=${configuration.autoPrep.enabled} confirmedMeetings=${configuration.autoPrep.meetings.length} installed=${status.installed} active=${status.active}`,
      )
    })
}

function schedulerOptions(configPath: string): SchedulerOptions {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`Automatic job installation is not supported on ${process.platform}`)
  }
  const scriptPath = process.argv[1]
  if (scriptPath === undefined || !isAbsolute(scriptPath) || !scriptPath.endsWith(".js")) {
    throw new Error(
      "Install from a built School Agent .js launcher, not a TypeScript development command",
    )
  }
  return {
    platform: process.platform,
    nodePath: process.execPath,
    scriptPath,
    configPath: resolve(configPath),
    label: "school-agent.auto-prep",
  }
}

function boundedInteger(value: string, min: number, max: number, label: string): number {
  const result = Number(value)
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`)
  }
  return result
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function localDate(value: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(value)
      .map((part) => [part.type, part.value]),
  )
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`
}
