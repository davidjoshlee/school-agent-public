import type { Command } from "commander"

import type { RootOptions } from "../cli.js"
import { loadConfig } from "./index.js"

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("Inspect and validate configuration")
  config
    .command("validate")
    .description("Validate school.config.json")
    .action(() => {
      const options = program.opts<RootOptions>()
      loadConfig(options.config)
      console.log(`Config valid: ${options.config}`)
    })
  config
    .command("show")
    .description("Print the effective configuration")
    .action(() => {
      const options = program.opts<RootOptions>()
      console.log(JSON.stringify(loadConfig(options.config), null, 2))
    })
}
