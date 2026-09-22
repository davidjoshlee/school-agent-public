/**
 * Bounded context assembly for `guidance propose` (see `guidance-propose.ts`
 * for the safety property and overall flow). Reads only: the syllabus, the
 * `maxAssignments` most recently dated assignment files, and up to
 * `maxFeedback` `.feedback.md` graded-feedback files on the user's own past
 * submissions — never the whole course. `detectDeliverable` (reused from
 * `deliverable.ts`, not reimplemented) runs over the sampled assignment
 * texts to tell the caller whether this class runs on discussion questions
 * or requirements.
 */
import { join } from "node:path"

import type { CoursePaths } from "../store/paths.js"
import { vaultLayout } from "../store/paths.js"
import { parseVaultDocument } from "../store/vault-document.js"
import { readDirectory, readOptional } from "../util/fs.js"
import { type Deliverable, type DeliverableSource, detectDeliverable } from "./deliverable.js"
import { parseStructure } from "./guidance.js"
import { estimateTokens } from "./retrieve.js"
import { readVaultText } from "./retrieve-files.js"

// Safety ceiling on how much of the course this reads.
const proposeContextBudget = 32_000
const maxAssignments = 5
const maxFeedback = 5
// Same precedence manifest.ts uses to pick one display date per document.
const dateSignals = ["unlock_at", "posted_at", "created_at", "due_at"] as const

export type GuidanceContext = {
  readonly context: string
  readonly deliverable: Deliverable
  /**
   * The course's ALREADY-declared '## Brief structure', if the user-owned
   * guidance/prep-guidance.md exists and declares one — read-only, so the
   * proposal can refine/extend a baseline instead of inventing a competing
   * structure. Never written to; see `proposeGuidance`'s safety property.
   */
  readonly existingStructure: readonly string[] | null
}

type MaterialEntry = { readonly path: string; readonly text: string; readonly date: string }

export async function assembleGuidanceContext(
  paths: CoursePaths,
  courseCode: string,
): Promise<GuidanceContext> {
  const syllabus = await readVaultText(paths.syllabus)
  const { assignments, feedback } = await recentAssignmentMaterial(paths.assignments)
  const deliverable = detectDeliverable(
    assignments.map((entry): DeliverableSource => ({ path: entry.path, text: entry.text })),
  )
  const context = assembleContext(courseCode, syllabus?.content ?? null, assignments, feedback)
  const existingStructure = await readExistingStructure(paths.guidance)
  return { context, deliverable, existingStructure }
}

// Read-only: this is the ONLY reference this module makes to the user-owned
// prep-guidance.md, and it is a read, never a write (the write boundary
// lives solely in `proposeGuidance`, targeting `paths.guidanceProposal`).
async function readExistingStructure(guidanceDir: string): Promise<readonly string[] | null> {
  const existing = await readVaultText(join(guidanceDir, "prep-guidance.md"))
  if (existing === null) return null
  const sections = parseStructure(existing.content).sections
  return sections.length === 0 ? null : sections
}

async function recentAssignmentMaterial(assignmentsDir: string): Promise<{
  readonly assignments: readonly MaterialEntry[]
  readonly feedback: readonly MaterialEntry[]
}> {
  const entries = await readDirectory(assignmentsDir)
  const assignments: MaterialEntry[] = []
  const feedback: MaterialEntry[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(vaultLayout.markdownExtension)) continue
    if (entry.name.endsWith(".summary.md")) continue
    const path = join(assignmentsDir, entry.name)
    const isFeedback = entry.name.endsWith(vaultLayout.feedback)
    const parsed = await readMaterial(path)
    if (parsed === null) continue
    ;(isFeedback ? feedback : assignments).push({ path, text: parsed.text, date: parsed.date })
  }
  const byRecency = (left: MaterialEntry, right: MaterialEntry): number =>
    right.date.localeCompare(left.date)
  return {
    assignments: assignments.sort(byRecency).slice(0, maxAssignments),
    feedback: feedback.sort(byRecency).slice(0, maxFeedback),
  }
}

async function readMaterial(
  path: string,
): Promise<{ readonly text: string; readonly date: string } | null> {
  const raw = await readOptional(path)
  if (raw === null) return null
  const parsed = parseVaultDocument(raw, path)
  return { text: parsed.content.trim(), date: bestDate(parsed.frontmatter.dates) }
}

function bestDate(dates: Readonly<Record<string, string | null>>): string {
  for (const signal of dateSignals) {
    const value = dates[signal]
    if (value !== undefined && value !== null) return value
  }
  return ""
}

function assembleContext(
  courseCode: string,
  syllabus: string | null,
  assignments: readonly MaterialEntry[],
  feedback: readonly MaterialEntry[],
): string {
  const parts = [
    `## Course\n${courseCode}`,
    syllabus === null ? "" : `## Syllabus excerpt\n${syllabus}`,
    assignments.length === 0
      ? ""
      : `## Recent assignments\n${assignments.map((entry) => `### ${entry.path}\n${entry.text}`).join("\n\n")}`,
    feedback.length === 0
      ? ""
      : `## Graded feedback on past submissions\n${feedback.map((entry) => `### ${entry.path}\n${entry.text}`).join("\n\n")}`,
  ].filter((part) => part.length > 0)
  return truncate(parts.join("\n\n"), proposeContextBudget)
}

function truncate(context: string, tokenBudget: number): string {
  if (estimateTokens(context) <= tokenBudget) return context
  const note = "\n[Truncated to fit the guidance-proposal context budget]"
  return `${context.slice(0, tokenBudget * 4 - note.length).trimEnd()}${note}`
}
