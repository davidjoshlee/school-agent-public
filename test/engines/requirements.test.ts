import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import { resolveRequirements } from "../../src/engines/requirements.js"
import { coursePaths } from "../../src/store/paths.js"
import { createVaultFrontmatter, renderVaultDocument } from "../../src/store/vault-document.js"
import { temporaryDirectory } from "../helpers/tempDir.js"

const course = { code: "STRAT 101", canvasId: "course-17" } as const
const defaultSections = ["Agenda", "Readings", "Concepts"] as const

const cueSources = [
  { path: "assignments/memo.md", text: "Required: 1. Compute X. 2. Compute Y." },
] as const

function document(content: string): string {
  return renderVaultDocument(
    createVaultFrontmatter({
      canvasId: "fixture",
      canvasUrl: "https://canvas.example.invalid/resource",
      type: "fixture",
      content,
      source: "sync",
      status: "approved",
      aiPolicy: "allowed",
    }),
    content,
  )
}

async function putGuidance(root: string, content: string): Promise<void> {
  const path = join(coursePaths(root, course.code, course.canvasId).guidance, "prep-guidance.md")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, document(content), "utf8")
}

describe("resolveRequirements", () => {
  it("non-regression: no declared guidance and no detectable cue leaves sections/deliverable untouched", async () => {
    const root = await temporaryDirectory("school-agent-requirements-")
    const result = await resolveRequirements({
      vaultRoot: root,
      courseCode: course.code,
      courseCanvasId: course.canvasId,
      defaultSections,
      sources: [{ path: "readings/ch1.md", text: "Chapter 1 covers oligopoly pricing." }],
    })

    expect(result.sections).toEqual(defaultSections)
    expect(result.readingsSection).toBe("Readings")
    expect(result.deliverable).toEqual({ kind: "none" })
  })

  it("detects a deliverable from the supplied sources when nothing is declared", async () => {
    const root = await temporaryDirectory("school-agent-requirements-")
    const result = await resolveRequirements({
      vaultRoot: root,
      courseCode: course.code,
      courseCanvasId: course.canvasId,
      defaultSections,
      sources: cueSources,
    })

    expect(result.sections).toEqual(defaultSections)
    if (result.deliverable.kind !== "requirements") {
      throw new Error("expected a detected requirements deliverable")
    }
    expect(result.deliverable.items.map((item) => item.text)).toEqual(["Compute X.", "Compute Y."])
  })

  it("precedence: a declared '## Deliverable' of none suppresses an otherwise-detected deliverable", async () => {
    const root = await temporaryDirectory("school-agent-requirements-")
    await putGuidance(root, ["Focus on the decision.", "## Deliverable", "none"].join("\n"))
    const result = await resolveRequirements({
      vaultRoot: root,
      courseCode: course.code,
      courseCanvasId: course.canvasId,
      defaultSections,
      sources: cueSources,
    })

    expect(result.deliverable).toEqual({ kind: "none" })
    // And: the suppression directive itself never leaks into the instructions.
    expect(result.instructions).not.toContain("## Deliverable")
    expect(result.instructions).toContain("Focus on the decision.")
  })

  it("declared '## Brief structure' sections still win over the defaults, deliverable detection unaffected", async () => {
    const root = await temporaryDirectory("school-agent-requirements-")
    await putGuidance(
      root,
      ["Quantify trade-offs.", "## Brief structure", "Agenda", "Key Takeaway"].join("\n"),
    )
    const result = await resolveRequirements({
      vaultRoot: root,
      courseCode: course.code,
      courseCanvasId: course.canvasId,
      defaultSections,
      sources: cueSources,
    })

    expect(result.sections).toEqual(["Agenda", "Key Takeaway"])
    expect(result.readingsSection).toBeNull()
    expect(result.deliverable.kind).toBe("requirements")
  })

  it("scope narrows detection to the named part", async () => {
    const root = await temporaryDirectory("school-agent-requirements-")
    const result = await resolveRequirements({
      vaultRoot: root,
      courseCode: course.code,
      courseCanvasId: course.canvasId,
      defaultSections,
      sources: [
        {
          path: "case.md",
          text: "Required: PART I: Analyze the transactions. PART II: (a) Prepare the statements.",
        },
      ],
      scope: "PART I",
    })

    if (result.deliverable.kind !== "requirements") {
      throw new Error("expected a requirements deliverable")
    }
    expect(result.deliverable.items).toHaveLength(1)
    expect(result.deliverable.items[0]?.id).toBe("PART I")
  })
})
