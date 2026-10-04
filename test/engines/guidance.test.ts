import { describe, expect, it } from "vitest"

import { parseDeliverableDirective, parseStructure } from "../../src/engines/guidance.js"

describe("guidance directive boundaries", () => {
  it("removes each directive while retaining surrounding free-form instructions", () => {
    const content = [
      "Focus on trade-offs.",
      "",
      "## Brief structure",
      "- Analysis",
      "- Sources Consulted",
      "",
      "## Deliverable",
      " NONE ",
      "",
      "## Notes",
      "Keep it concise.",
    ].join("\n")

    const structure = parseStructure(content)
    expect(structure.sections).toEqual(["Analysis", "Sources Consulted"])
    expect(structure.readingsSection).toBe("Sources Consulted")
    const deliverable = parseDeliverableDirective(structure.instructions)
    expect(deliverable).toEqual({
      suppressed: true,
      instructions: "Focus on trade-offs.\n\n## Notes\nKeep it concise.",
    })
  })

  it("reads directive bodies through EOF without requiring a trailing newline", () => {
    expect(parseStructure("Intro\n## Prep brief structure\nAnalysis, Readings")).toEqual({
      sections: ["Analysis", "Readings"],
      readingsSection: "Readings",
      instructions: "Intro",
    })
    expect(parseDeliverableDirective("Intro\n## Deliverable\nnone")).toEqual({
      suppressed: true,
      instructions: "Intro",
    })
  })

  it("handles an empty directive at EOF", () => {
    expect(parseStructure("Intro\n## Brief structure")).toEqual({
      sections: [],
      readingsSection: null,
      instructions: "Intro",
    })
    expect(parseDeliverableDirective("Intro\n## Deliverable")).toEqual({
      suppressed: false,
      instructions: "Intro",
    })
  })

  it("leaves guidance without directives intact except for surrounding whitespace", () => {
    const content = "  Focus on trade-offs.\n\n## Notes\nKeep it concise.  "
    expect(parseStructure(content)).toEqual({
      sections: [],
      readingsSection: null,
      instructions: content.trim(),
    })
    expect(parseDeliverableDirective(content)).toEqual({
      suppressed: false,
      instructions: content.trim(),
    })
  })
})
