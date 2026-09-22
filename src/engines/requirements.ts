/**
 * The one seam both the prep and draft prompt builders (and their
 * validators) cross to learn what an artifact must contain: the sections
 * a human declared, PLUS what the assignment actually asks (`deliverable.js`).
 *
 * Precedence is the whole point — declared beats detected beats default:
 *  - `sections` / `readingsSection` / `instructions`: exactly
 *    `resolvePrepStructure`'s old behavior (declared `## Brief structure`
 *    sections, else the caller's defaults). Unchanged by this module.
 *  - `deliverable`: `detectDeliverable(sources, scope)`, UNLESS the guidance
 *    file declares `## Deliverable\nnone`, in which case detection is
 *    skipped entirely and the result is forced to `{ kind: "none" }`. That
 *    suppression is deliberate: a human's explicit "don't auto-detect for
 *    this class" must never be second-guessed by a heuristic.
 *
 * The draft engine's guidance lives in a different file (a per-assignment
 * guidance doc, not `guidance/prep-guidance.md`), so a caller that has
 * already loaded its own guidance text passes it as `guidanceContent` and
 * this module skips the vault read.
 */

import { resolve } from "node:path"

import { coursePaths } from "../store/paths.js"
import { type Deliverable, type DeliverableSource, detectDeliverable } from "./deliverable.js"
import { parseDeliverableDirective, parseStructure } from "./guidance.js"
import { readVaultText } from "./retrieve-files.js"

export type ArtifactRequirements = {
  /** The ordered list of H2 section headings the artifact must contain. */
  readonly sections: readonly string[]
  /** True when `sections` came from a declared `## Brief structure`, false when it's `defaultSections`. */
  readonly sectionsDeclared: boolean
  /** The declared section that holds reading links, or null when none is declared. */
  readonly readingsSection: string | null
  /** The guidance's free-form instructions with directive blocks removed. */
  readonly instructions: string
  /** What the assignment actually asks for, or `{ kind: "none" }`. */
  readonly deliverable: Deliverable
}

export type ResolveRequirementsInput = {
  readonly vaultRoot: string
  readonly courseCode: string
  readonly courseCanvasId: string
  readonly defaultSections: readonly string[]
  /** Candidate deliverable sources, in priority order (strongest cue wins; ties go to the earlier source). */
  readonly sources: readonly DeliverableSource[]
  /** An optional part selector extracted from the assignment body, e.g. "PART I". */
  readonly scope?: string | undefined
  /**
   * Pre-loaded guidance text to use instead of reading `guidance/prep-guidance.md`
   * from the vault — the draft engine already has its own per-assignment
   * guidance file loaded and would otherwise be read twice.
   */
  readonly guidanceContent?: string | undefined
}

/**
 * Resolves the full set of requirements for a generated artifact (prep brief
 * or assignment draft) from a course's `guidance/prep-guidance.md`, honoring
 * declared structure and deliverable suppression before falling back to
 * detection and defaults.
 */
export async function resolveRequirements(
  input: ResolveRequirementsInput,
): Promise<ArtifactRequirements> {
  const guidanceContent = input.guidanceContent ?? (await readGuidanceFromVault(input))
  const structure = parseStructure(guidanceContent)
  const deliverableDirective = parseDeliverableDirective(structure.instructions)
  const declared = structure.sections.length > 0
  const deliverable = deliverableDirective.suppressed
    ? ({ kind: "none" } as const)
    : detectDeliverable(input.sources, input.scope)
  return {
    sections: declared ? structure.sections : input.defaultSections,
    sectionsDeclared: declared,
    readingsSection: declared ? structure.readingsSection : "Readings",
    instructions: deliverableDirective.instructions,
    deliverable,
  }
}

async function readGuidanceFromVault(
  input: Pick<ResolveRequirementsInput, "vaultRoot" | "courseCode" | "courseCanvasId">,
): Promise<string> {
  const path = coursePaths(input.vaultRoot, input.courseCode, input.courseCanvasId).guidance
  const guidance = await readVaultText(resolve(path, "prep-guidance.md"))
  return guidance?.content ?? ""
}
