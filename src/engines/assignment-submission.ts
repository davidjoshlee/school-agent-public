/**
 * The gated draft carries scaffolding a real submission must not: the
 * provenance comment, a `## Missing required sources` banner, an optional
 * leading "assignment info" header the model sometimes prepends (a `#`
 * title plus bold `**Key:** value` metadata lines), `## Computations`, and
 * `## Correctness check`. `approveAssignment` strips all of it so `final/`
 * holds only the submittable deliverable.
 */

import { withoutAssignmentProvenance } from "./assignment-provenance.js"

const strippedHeadings = ["## Missing required sources", "## Computations", "## Correctness check"]

export function extractSubmissionContent(content: string): string {
  let result = withoutAssignmentProvenance(content)
  for (const heading of strippedHeadings) {
    result = stripSection(result, heading)
  }
  result = stripLeadingAssignmentHeader(result)
  return result
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^-{3,}\s*\n+/, "")
    .trim()
}

// Removes a named H2 section, from its heading through (but not including)
// the next `#`/`##` heading, or the end of the document when it is last.
function stripSection(content: string, heading: string): string {
  const start = content.indexOf(heading)
  if (start < 0) {
    return content
  }
  const rest = content.slice(start + heading.length)
  const next = /^#{1,2} /m.exec(rest)
  const end = next === null ? content.length : start + heading.length + next.index
  return content.slice(0, start) + content.slice(end)
}

// Only fires on a leading `# Title` immediately followed by `**Key:**
// value` metadata lines (and blank lines) and an optional `---` divider —
// the shape the draft prompt's freeform framing tends to produce. Any other
// leading heading (the deliverable's own first section) is left untouched.
function stripLeadingAssignmentHeader(content: string): string {
  const lines = content.split("\n")
  let i = 0
  while (i < lines.length && lines[i]?.trim() === "") {
    i++
  }
  if (!lines[i]?.startsWith("# ")) {
    return content
  }
  i++
  while (i < lines.length && (lines[i]?.trim() === "" || /^\*\*[^*]+:\*\*/.test(lines[i] ?? ""))) {
    i++
  }
  if (lines[i]?.trim() !== "---") {
    return content
  }
  i++
  while (i < lines.length && lines[i]?.trim() === "") {
    i++
  }
  return lines.slice(i).join("\n")
}
