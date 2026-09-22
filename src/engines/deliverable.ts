/**
 * Deterministic (no LLM) answer to "what does this assignment actually ask
 * the student to produce?" A regex-based parser, not a model call, because
 * that's what makes it evaluable with precision/recall tests instead of
 * vibes.
 *
 * PDF-extracted assignment text is often whitespace-mangled: dropped-cap
 * artifacts ("S   TUDY   G   UIDE") and entire sections collapsed onto one
 * line with no newlines between list items. `normalize()` repairs both
 * before any cue or enumerator matching runs, so the same regexes work on
 * "clean" markdown and on mangled PDF extractions alike.
 *
 * The other correctness property this module exists for: numbered facts
 * inside a case (the transactions a company "engaged in") are NOT a
 * deliverable — only content that follows a directive cue (`Required:`,
 * "Prepare your answers to the following questions", …) counts. See
 * `deliverable-enumerate.ts` for the part/enumerator parsing this builds on.
 */

import { findParts, parseEnumeratedItems } from "./deliverable-enumerate.js"

export type DeliverableItem = {
  /** Stable, source-derived id: "1", "2", "a", "PART I.a". */
  readonly id: string
  /** The question/requirement text, whitespace-normalized. */
  readonly text: string
}

export type Deliverable =
  | { readonly kind: "none" }
  | {
      readonly kind: "questions"
      readonly items: readonly DeliverableItem[]
      readonly sourcePath: string
      readonly cue: string
    }
  | {
      readonly kind: "requirements"
      readonly items: readonly DeliverableItem[]
      readonly sourcePath: string
      readonly cue: string
    }

export type DeliverableSource = { readonly path: string; readonly text: string }

type CueKind = "questions" | "requirements"

type CueDef = {
  readonly label: string
  readonly pattern: RegExp
  readonly kind: CueKind
  /** Higher wins when several sources/cues match; ties fall back to the
   * caller's source priority order. */
  readonly strength: number
}

/** Directive cues that introduce a deliverable, matched case-insensitively
 * against the normalized text. Add new phrasings here. */
export const DELIVERABLE_CUES: readonly CueDef[] = [
  {
    label: "Prepare your answers to the following questions",
    pattern: /prepare your answers to the following questions/i,
    kind: "questions",
    strength: 3,
  },
  { label: "Required:", pattern: /\brequired\s*:/i, kind: "requirements", strength: 3 },
  {
    label: "Prepare the following",
    pattern: /\bprepare the following\b/i,
    kind: "requirements",
    strength: 2,
  },
  {
    label: "Answer the following questions",
    pattern: /\banswer the following questions\b/i,
    kind: "questions",
    strength: 2,
  },
  {
    label: "Questions for discussion",
    pattern: /\bquestions for discussion\b/i,
    kind: "questions",
    strength: 2,
  },
  {
    label: "Discussion questions",
    pattern: /\bdiscussion questions\b/i,
    kind: "questions",
    strength: 2,
  },
  {
    label: "Assignment questions",
    pattern: /\bassignment questions\b/i,
    kind: "questions",
    strength: 2,
  },
]

type Match = {
  readonly path: string
  readonly normalized: string
  readonly cue: CueDef
  readonly afterCue: number
  readonly priority: number
}

/** `scope`: an optional part selector from the assignment body, e.g. "PART I". */
export function detectDeliverable(
  sources: readonly DeliverableSource[],
  scope?: string | undefined,
): Deliverable {
  let best: Match | null = null
  for (let priority = 0; priority < sources.length; priority += 1) {
    const source = sources[priority]
    if (source === undefined) continue
    const normalized = normalize(source.text)
    for (const cue of DELIVERABLE_CUES) {
      const match = cue.pattern.exec(normalized)
      if (match === null) continue
      const beats =
        best === null ||
        cue.strength > best.cue.strength ||
        (cue.strength === best.cue.strength && priority < best.priority)
      if (beats) {
        best = {
          path: source.path,
          normalized,
          cue,
          afterCue: match.index + match[0].length,
          priority,
        }
      }
    }
  }
  if (best === null) return { kind: "none" }
  const rawItems = extractItems(best.normalized, best.afterCue, scope)
  const items = rawItems
    .map((item) => ({ id: item.id, text: cleanItemText(item.text) }))
    .filter((item) => item.text.length > 0)
  if (items.length === 0) return { kind: "none" }
  return { kind: best.cue.kind, items, sourcePath: best.path, cue: best.cue.label }
}

/** The two-way `kind` synonym wording an engine wants in its own prompt. */
export type DeliverableFraming = { readonly questions: string; readonly requirements: string }

// The one place the `kind === "questions"` vs `"requirements"` framing decision
// is made; prep and draft prompt builders call this with their own wording.
export function deliverableFraming(deliverable: Deliverable, framing: DeliverableFraming): string {
  if (deliverable.kind === "none") return ""
  return deliverable.kind === "questions" ? framing.questions : framing.requirements
}

// Renders `deliverable.items` as one `### <id>. <text>` heading per item.
export function formatDeliverableItems(deliverable: Deliverable): string {
  if (deliverable.kind === "none") return ""
  return deliverable.items.map((item) => `### ${item.id}. ${item.text}`).join("\n")
}

function extractItems(
  text: string,
  from: number,
  scope: string | undefined,
): readonly DeliverableItem[] {
  const parts = findParts(text, from)
  if (parts.length === 0) {
    return parseEnumeratedItems(text, from, text.length)
  }
  if (scope !== undefined) {
    const target = parts.find((part) => part.name.toLowerCase() === scope.toLowerCase())
    return target === undefined
      ? []
      : itemsForSpan(text, target.start, target.end, target.name, false)
  }
  return parts.flatMap((part) => itemsForSpan(text, part.start, part.end, part.name, true))
}

function itemsForSpan(
  text: string,
  start: number,
  end: number,
  partName: string,
  prefixed: boolean,
): readonly DeliverableItem[] {
  const items = parseEnumeratedItems(text, start, end)
  if (items.length > 0) {
    return prefixed
      ? items.map((item) => ({ id: `${partName}.${item.id}`, text: item.text }))
      : items
  }
  // No sub-enumeration in this part's span: the part itself is one
  // unenumerated requirement (e.g. PART I's single prose paragraph).
  const wholeText = text.slice(start, end).trim()
  return wholeText.length === 0 ? [] : [{ id: partName, text: wholeText }]
}

// Dropped-cap PDF extraction renders a word's first capital with wide
// letter-spacing, e.g. "S   TUDY   G   UIDE" for "STUDY GUIDE": a run of 2+
// spaces/tabs splits a standalone capital from the rest of its word. This
// repair runs BEFORE whitespace collapsing (which would erase the 2+ space
// signal) and repeats since fixing the leftmost occurrence can reveal the
// next one immediately to its right.
function repairDroppedCaps(text: string): string {
  const dropped = /\b([A-Z])[ \t]{2,}([A-Za-z]+)\b/
  let result = text
  for (let iterations = 0; iterations < 40; iterations += 1) {
    const next = result.replace(dropped, "$1$2")
    if (next === result) return result
    result = next
  }
  return result
}

function normalize(text: string): string {
  return repairDroppedCaps(text).replace(/\s+/g, " ").trim()
}

// A part span sometimes starts with its own "(due ...)" or "(due ...):"
// due-date parenthetical (from "PART I (due Thursday, September 25):"),
// or a leftover bare colon — scaffolding, not the instruction itself.
const dueParenthetical = /^\(\s*due\b[^)]*\)\s*:?\s*/i
const leadingColon = /^:\s*/

function stripLeadingScaffolding(text: string): string {
  return text.replace(dueParenthetical, "").replace(leadingColon, "")
}

// PDF extraction sometimes runs the next page's running header/footer
// straight into the last item on a page (e.g. "...in 2022? 2 RADIATION
// SHIELDS INC. TRANSACTION ANALYSIS..."). Trimming is conservative — it
// only fires immediately after a sentence-ending punctuation mark, followed
// by an optional page number and a long ALL-CAPS run — never mid-sentence.
const pageFurniture = /([.?!])\s+\d{0,3}\s*[A-Z][A-Z0-9 .,'&-]{12,}/

function trimPageFurniture(text: string): string {
  const match = pageFurniture.exec(text)
  return match === null ? text : text.slice(0, match.index + 1)
}

function cleanItemText(text: string): string {
  return trimPageFurniture(stripLeadingScaffolding(text)).trim()
}
