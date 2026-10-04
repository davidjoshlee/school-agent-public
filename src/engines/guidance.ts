/**
 * Per-class steerability: a guidance file may declare an explicit brief/draft
 * structure with an H2 heading — `## Brief structure` or `## Prep brief
 * structure` — listing the H2 section names the artifact must contain, one per
 * line or comma-separated. The declaration is parsed deterministically here so
 * the engines can require exactly those sections without relying on the model
 * to interpret free-form prose.
 *
 * When no structure is declared the engines fall back to their defaults, and
 * the free-form guidance text (minus the structure block) still flows into the
 * prompt as per-class instructions.
 *
 * A guidance file may also declare `## Deliverable` with a body of `none` to
 * suppress automatic deliverable detection (`../engines/deliverable.js`) for
 * that class — the human always wins over the heuristic. See
 * `resolveRequirements` (`requirements.js`) for where this is combined with
 * detection.
 */

export type ParsedStructure = {
  /** The ordered list of H2 section headings the artifact must contain. */
  readonly sections: readonly string[]
  /** The declared section that holds reading links, or null when none is declared. */
  readonly readingsSection: string | null
  /** The guidance's free-form instructions with the structure block removed. */
  readonly instructions: string
}

export type DeliverableDirective = {
  /** True when the guidance explicitly declares `## Deliverable` with body `none`. */
  readonly suppressed: boolean
  /** `content` with the `## Deliverable` block removed, if present. */
  readonly instructions: string
}

// Matches `## Brief structure` or `## Prep brief structure` (case-insensitive).
const structureHeader = /^##\s+(?:prep\s+)?brief\s+structure\s*$/im
const nextHeader = /^##\s+/m
// Heuristic for the section that carries reading links. Priority order: reading,
// reference, source, material. "Required Reading", "Sources Consulted", etc. all match.
const readingSectionName = /\b(?:readings?|references?|sources?|materials?)\b/i
const deliverableHeader = /^##\s+deliverable\s*$/im

/**
 * Parses a `## Deliverable` block, if present, stripping it from the
 * returned `instructions` regardless of its body — suppression itself only
 * fires when the body is exactly `none` (case-insensitive).
 */
export function parseDeliverableDirective(content: string): DeliverableDirective {
  const match = deliverableHeader.exec(content)
  if (match === null || match.index === undefined) {
    return { suppressed: false, instructions: content.trim() }
  }
  const block = extractH2Block(content, match.index)
  return { suppressed: /^none$/i.test(block.body.trim()), instructions: block.instructions }
}

export function parseStructure(content: string): ParsedStructure {
  const match = structureHeader.exec(content)
  if (match === null || match.index === undefined) {
    return { sections: [], readingsSection: null, instructions: content.trim() }
  }
  const block = extractH2Block(content, match.index)
  const sections = declaredSections(block.body)
  const readingsSection = sections.find((name) => readingSectionName.test(name)) ?? null
  return { sections, readingsSection, instructions: block.instructions }
}

function extractH2Block(
  content: string,
  start: number,
): { readonly body: string; readonly instructions: string } {
  const headingEnd = content.indexOf("\n", start)
  const bodyStart = headingEnd === -1 ? content.length : headingEnd + 1
  const rest = content.slice(bodyStart)
  const end = nextHeader.exec(rest)
  // H2 directives run to the next H2 heading or the end of the content.
  const bodyEnd = end === null || end.index === undefined ? rest.length : end.index
  const instructions = `${content.slice(0, start)}${content.slice(bodyStart + bodyEnd)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return { body: rest.slice(0, bodyEnd), instructions }
}

function declaredSections(block: string): readonly string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const rawLine of block.split("\n")) {
    const line = rawLine
      .trim()
      .replace(/^[-*+]\s+/, "")
      .replace(/^#+\s*/, "")
      .trim()
    if (line.length === 0) {
      continue
    }
    for (const part of line.split(",")) {
      const name = part.trim()
      if (name.length > 0 && !seen.has(name)) {
        seen.add(name)
        names.push(name)
      }
    }
  }
  return names
}
