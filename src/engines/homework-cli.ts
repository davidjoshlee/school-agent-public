import type { Command } from "commander"
import { z } from "zod"

import { loadConfig } from "../config/index.js"
import { createSchoolIndex } from "../store/db.js"
import { runAssignmentDraft } from "./assignment-cli.js"
import { listHomework, renderHomework, resolveCourseCodes } from "./homework.js"

const homeworkOptionsSchema = z.strictObject({
  days: z.coerce.number().int().positive().default(14),
  course: z.string().min(1).optional(),
  draft: z.string().min(1).optional(),
})

type RootOptions = { readonly config: string; readonly model?: string }

export function registerHomeworkCommand(program: Command): void {
  const homework = program
    .command("homework")
    .description("List gradeable assignments due soon, or draft one by Canvas id")
    .option("--days <number>", "how many days ahead to list", "14")
    .option("--course <id-or-code>", "restrict the listing to one course")
    .option("--draft <assignment-id>", "draft the assignment with this Canvas id")
  homework.action(async () => {
    const root = program.opts<RootOptions>()
    const options = homeworkOptionsSchema.parse(homework.opts())
    const configuration = loadConfig(root.config)
    if (options.draft !== undefined) {
      const result = await runAssignmentDraft(configuration, root.model, options.draft)
      console.log(`${result.runId}\t${result.path}`)
      return
    }
    const index = createSchoolIndex({ path: configuration.index.path })
    try {
      const courseCodes = resolveCourseCodes(index, configuration.courses, options.course)
      const rows = await listHomework({
        index,
        vaultRoot: configuration.vault.path,
        days: options.days,
        now: new Date(),
        courseCodes,
      })
      console.log(renderHomework(rows, options.days))
    } finally {
      index.close()
    }
  })
}
