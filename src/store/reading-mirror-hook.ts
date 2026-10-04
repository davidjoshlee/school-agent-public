import { dirname, join, resolve } from "node:path"
import type { Command } from "commander"

import type { RootOptions } from "../cli.js"
import { loadConfig } from "../config/index.js"
import { refreshConfiguredReadingMirror } from "./reading-mirror.js"

/** Only successful writing commands refresh an explicitly configured reading copy. */
export function registerReadingMirrorHook(program: Command): void {
  program.hook("postAction", async (_root, action) => {
    const name = action.name()
    const options = action.opts<{ readonly discuss?: string; readonly draft?: string }>()
    const writes =
      ["sync", "ingest", "prep", "revise", "approve"].includes(name) ||
      (name === "draft" && options.discuss === undefined) ||
      (name === "homework" && options.draft !== undefined)
    if (!writes) return
    try {
      const configPath = resolve(program.opts<RootOptions>().config)
      const configuration = loadConfig(configPath)
      const result = await refreshConfiguredReadingMirror(configuration.vault.path, [
        configPath,
        join(dirname(configPath), ".env"),
        configuration.index.path,
      ])
      if (result)
        console.log(
          `Reading copy refreshed: ${result.updated} updated, ${result.unchanged} unchanged, ${result.recovered} recovered.`,
        )
    } catch {
      // The primary write already succeeded. Do not imply that it failed or expose source details.
      console.warn(
        "Reading copy refresh failed; local work succeeded. Run vault reading-copy --current --apply with your saved destination to diagnose.",
      )
    }
  })
}
