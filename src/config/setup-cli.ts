import type { Command } from "commander"

import type { RootOptions } from "../cli.js"
import { createStarterConfig, doctor, setupOptionsSchema } from "./setup.js"

type SetupCliOptions = { readonly canvasUrl: string }
type DoctorCliOptions = { readonly syncOnly: boolean }

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Create a safe local starter configuration (offline)")
    .requiredOption("--canvas-url <url>", "your school's HTTPS Canvas URL")
    .action((options: SetupCliOptions) => {
      const root = program.opts<RootOptions>()
      const result = createStarterConfig(root.config, setupOptionsSchema.parse(options))
      console.log(`Created ${result.configPath}`)
      console.log(`Created ${result.environmentPath} (empty credential template)`)
      console.log(
        "Next: edit .env to set CANVAS_TOKEN, then run school-agent doctor with this config.",
      )
    })

  program
    .command("doctor")
    .description("Check local setup without contacting Canvas or an AI provider")
    .option("--sync-only", "only plan to sync Canvas content")
    .action((options: DoctorCliOptions) => {
      const root = program.opts<RootOptions>()
      const report = doctor(root.config, options)
      for (const finding of report.findings) {
        const marker = finding.level === "ok" ? "OK" : finding.level.toUpperCase()
        console.log(`${marker}: ${finding.message}`)
      }
      if (!report.healthy)
        throw new Error(
          "Doctor found setup errors. Fix the items above and run school doctor again.",
        )
    })
}
