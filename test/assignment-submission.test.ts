import { describe, expect, it } from "vitest"
import { renderAssignmentProvenance } from "../src/engines/assignment-provenance.js"
import { extractSubmissionContent } from "../src/engines/assignment-submission.js"

const provenance = renderAssignmentProvenance({
  course: {
    code: "TEST-101",
    canvas_id: "1",
    canvas_url: "https://canvas.example.invalid/courses/1",
  },
  assignment: {
    canvas_id: "2",
    title: "Reflection",
    slug: "reflection",
    canvas_url: "https://canvas.example.invalid/courses/1/assignments/2",
    group_category_id: null,
  },
  ai_policy: "allowed",
  model_ids: { draft: "mock/model", discuss: "mock/model" },
  source_files: ["a.md"],
  timestamp: new Date().toISOString(),
  version: 1,
  run_id: "00000000-0000-4000-8000-000000000000",
})

describe("extractSubmissionContent", () => {
  it("strips provenance, missing-sources banner, assignment info header, computations, and correctness check", () => {
    const draft = [
      provenance,
      "## Missing required sources",
      "",
      "Needed the Country Comparison Tool.",
      "",
      "---",
      "",
      "# Deliverable: Reflection",
      "**Format:** Written reflection",
      "**Module:** Module 2",
      "",
      "---",
      "",
      "### My Reflection",
      "",
      "The real submittable content goes here.",
      "",
      "## Computations",
      "",
      "- word_count — 417",
      "",
      "## Correctness check",
      "",
      "**Verified**",
      "- Everything checks out.",
    ].join("\n")

    const result = extractSubmissionContent(draft)

    expect(result).toBe(
      ["### My Reflection", "", "The real submittable content goes here."].join("\n"),
    )
  })

  it("leaves a draft with no scaffolding untouched aside from the provenance header", () => {
    const draft = [provenance, "Just the deliverable text, nothing else."].join("\n\n")

    expect(extractSubmissionContent(draft)).toBe("Just the deliverable text, nothing else.")
  })

  it("does not strip a real first section heading that happens to start with '#'", () => {
    const draft = [provenance, "# My Own Title", "", "This is real content, not metadata."].join(
      "\n\n",
    )

    expect(extractSubmissionContent(draft)).toBe(
      ["# My Own Title", "", "This is real content, not metadata."].join("\n"),
    )
  })
})
