import { z } from "zod"

export const assignmentProvenanceSchema = z.strictObject({
  course: z.strictObject({
    code: z.string().min(1),
    canvas_id: z.string().min(1),
    canvas_url: z.url(),
  }),
  assignment: z.strictObject({
    canvas_id: z.string().min(1),
    title: z.string().min(1),
    slug: z.string().min(1),
    canvas_url: z.url(),
    group_category_id: z.string().min(1).nullable(),
  }),
  ai_policy: z.enum(["allowed", "prohibited"]),
  model_ids: z.strictObject({ draft: z.string().min(1), discuss: z.string().min(1) }),
  source_files: z.array(z.string().min(1)).min(1),
  timestamp: z.iso.datetime(),
  version: z.number().int().positive(),
  run_id: z.string().uuid(),
})

export type AssignmentProvenance = z.infer<typeof assignmentProvenanceSchema>

export class AssignmentProvenanceError extends Error {
  readonly name = "AssignmentProvenanceError"

  constructor(readonly detail: string) {
    super(`Invalid assignment provenance: ${detail}`)
  }
}

const headerStart = "<!-- school-agent-provenance\n"
const headerEnd = "\n-->"

export function renderAssignmentProvenance(provenance: AssignmentProvenance): string {
  return `${headerStart}${JSON.stringify(assignmentProvenanceSchema.parse(provenance))}${headerEnd}`
}

export function parseAssignmentProvenance(content: string): AssignmentProvenance {
  const start = content.indexOf(headerStart)
  if (start < 0) {
    throw new AssignmentProvenanceError("header is missing")
  }
  const end = content.indexOf(headerEnd, start + headerStart.length)
  if (end < 0) {
    throw new AssignmentProvenanceError("header is unterminated")
  }
  try {
    return assignmentProvenanceSchema.parse(
      JSON.parse(content.slice(start + headerStart.length, end)),
    )
  } catch (error: unknown) {
    throw new AssignmentProvenanceError(error instanceof Error ? error.message : String(error))
  }
}

export function withoutAssignmentProvenance(content: string): string {
  parseAssignmentProvenance(content)
  const start = content.indexOf(headerStart)
  const end = content.indexOf(headerEnd, start + headerStart.length)
  return content.slice(end + headerEnd.length).trimStart()
}
