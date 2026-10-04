import type { Command } from "commander"

import type { RootOptions } from "../cli.js"
import { checkAiReadiness } from "../models/ai-readiness.js"
import { loadConfig } from "./index.js"
import { createStarterConfig, doctor, setupOptionsSchema } from "./setup.js"

type SetupCliOptions = { readonly canvasUrl: string }
type DoctorCliOptions = { readonly syncOnly: boolean; readonly ai: boolean }

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
    .description("Check local setup offline by default; --ai opts into AI Gateway calls")
    .option("--sync-only", "only plan to sync Canvas content")
    .option("--ai", "opt in to checking AI Gateway model access with tiny test generations")
    .action(async (options: DoctorCliOptions) => {
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
      if (options.ai) {
        console.log(
          "WARNING: AI readiness sends synthetic prompts to AI Gateway and may incur provider charges. Probe costs are not recorded in the local usage ledger or governed by its monthly cap.",
        )
        const configuration = loadConfig(root.config)
        const readiness = await checkAiReadiness(
          configuration,
          process.env["AI_GATEWAY_API_KEY"],
          undefined,
          root.model,
        )
        for (const finding of readiness.findings) {
          const marker = finding.level === "ok" ? "OK" : finding.level.toUpperCase()
          console.log(`${marker}: ${finding.message}`)
        }
        if (!readiness.healthy)
          throw new Error(
            "AI readiness failed. Follow the guidance above, then run school doctor --ai again.",
          )
      }
    })
}
