import type { Command } from "commander"
import { z } from "zod"

import { loadConfig } from "../config/index.js"
import { createSchoolIndex } from "../store/db.js"
import { buildTimeline, renderTimeline } from "./timeline.js"

const timelineOptionsSchema = z.strictObject({
  weeks: z.coerce.number().int().positive().default(4),
  course: z.string().min(1).optional(),
})

type RootOptions = { readonly config: string }

export function registerTimelineCommand(program: Command): void {
  const timeline = program
    .command("timeline")
    .description("Show an override-aware cross-course due-date timeline")
    .option("--weeks <number>", "number of upcoming weeks to show", "4")
    .option("--course <code>", "show only one course code")
  timeline.action(() => {
    const root = program.opts<RootOptions>()
    const options = timelineOptionsSchema.parse(timeline.opts())
    const configuration = loadConfig(root.config)
    const index = createSchoolIndex({ path: configuration.index.path })
    try {
      console.log(
        renderTimeline(
          buildTimeline({
            index,
            weeks: options.weeks,
            ...(options.course === undefined ? {} : { course: options.course }),
            now: new Date(),
          }),
        ),
      )
    } finally {
      index.close()
    }
  })
}
