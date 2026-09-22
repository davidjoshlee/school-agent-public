import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import { assembleCourseContext } from "../src/engines/retrieve.js"
import { loadCourseModules } from "../src/engines/retrieve-modules.js"
import {
  selectModulesForAssignment,
  selectModulesForPeriod,
} from "../src/engines/retrieve-selection.js"
import { coursePaths, slugify, vaultPaths } from "../src/store/paths.js"
import { renderVaultDocument } from "../src/store/vault.js"
import { createVaultFrontmatter } from "../src/store/vault-document.js"
import { realSchoolModels, schoolConfig } from "./helpers/schoolConfig.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

const course = { code: "ACCT 213", canvasId: "course-9" } as const

function config(): ReturnType<typeof schoolConfig> {
  return schoolConfig({
    vaultPath: "unused",
    indexPath: ":memory:",
    pilotCourseId: null,
    canvas: { baseUrl: "https://canvas.example.invalid" },
    models: realSchoolModels,
  })
}

async function put(
  path: string,
  canvasId: string,
  content: string,
  dates: Readonly<Record<string, string>> = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    renderVaultDocument(
      createVaultFrontmatter({
        canvasId,
        canvasUrl: `https://canvas.example.invalid/${canvasId}`,
        type: "fixture",
        content,
        dates,
        source: "sync",
        status: "final",
        aiPolicy: "allowed",
      }),
      content,
    ),
    "utf8",
  )
}

const session7HomeworkTitle = "Session 7 Homework"
const session7SlidesTitle = "Session 7 Slides"
const session8AssignmentTitle = "Session 8 Assignment -- ExampleCo"
const session8SlidesTitle = "Session 8 Slides"
const session9HomeworkTitle = "Session 9 Homework"
const session9SlidesTitle = "Session 9 Slides"
const session6HomeworkTitle = "Session 6 Homework"

/**
 * A three-session vault (7, 8, 9) plus an older-form session 6 module,
 * shaped like real sync output: one module-root doc per session (renderModule
 * shape) referencing an Assignment + File item each, and the vault documents
 * those items resolve to.
 */
async function threeSessionVault(): Promise<string> {
  const root = await temporaryDirectory("school-agent-retrieve-modules-")
  const paths = coursePaths(root, course.code, course.canvasId)

  await put(
    join(paths.modules, "06-session-6-601m", "session-6.md"),
    "601m",
    [
      "Session 6",
      "",
      `- Assignment: ${session6HomeworkTitle}`,
      `- File: ${slugify(session6HomeworkTitle, "slides")}`,
    ].join("\n"),
  )
  await put(
    join(paths.assignments, `${slugify(session6HomeworkTitle, "untitled")}.md`),
    "601-old",
    "Session 6 homework prompt.",
  )

  await put(
    join(paths.modules, "07-session-7-701", "session-7.md"),
    "701",
    [
      "Session 7",
      "",
      `- File: ${session7SlidesTitle} (canvas_id: 501)`,
      `- Assignment: ${session7HomeworkTitle} (canvas_id: 601)`,
    ].join("\n"),
    { unlock_at: "2025-10-09T00:00:00.000Z" },
  )
  await put(
    join(paths.files, `${slugify(session7SlidesTitle, "slides")}.md`),
    "501",
    "Slides 7 body.",
  )
  await put(
    join(paths.assignments, `${slugify(session7HomeworkTitle, "untitled")}.md`),
    "601",
    "Homework 7 prompt.",
  )

  await put(
    join(paths.modules, "08-session-8-801", "session-8.md"),
    "801",
    [
      "Session 8",
      "",
      `- File: ${session8SlidesTitle} (canvas_id: 502)`,
      `- Assignment: ${session8AssignmentTitle} (canvas_id: 602)`,
    ].join("\n"),
    { unlock_at: "2025-10-16T00:00:00.000Z" },
  )
  await put(
    join(paths.files, `${slugify(session8SlidesTitle, "slides")}.md`),
    "502",
    "Slides 8 body.",
  )
  await put(
    join(paths.assignments, `${slugify(session8AssignmentTitle, "untitled")}.md`),
    "602",
    "ExampleCo assignment prompt.",
  )

  await put(
    join(paths.modules, "09-session-9-901", "session-9.md"),
    "901",
    [
      "Session 9",
      "",
      `- File: ${session9SlidesTitle} (canvas_id: 503)`,
      `- Assignment: ${session9HomeworkTitle} (canvas_id: 603)`,
    ].join("\n"),
    { unlock_at: "2025-10-23T00:00:00.000Z" },
  )
  await put(
    join(paths.files, `${slugify(session9SlidesTitle, "slides")}.md`),
    "503",
    "Slides 9 body.",
  )
  await put(
    join(paths.assignments, `${slugify(session9HomeworkTitle, "untitled")}.md`),
    "603",
    "Homework 9 prompt.",
  )

  return root
}

describe("loadCourseModules", () => {
  it("resolves new-form canvas_id item lines and old-form title-only item lines", async () => {
    const root = await threeSessionVault()
    try {
      const courseRoot = coursePaths(root, course.code, course.canvasId).root
      const modules = await loadCourseModules(courseRoot)

      expect(modules.map((module) => module.title)).toEqual([
        "Session 6",
        "Session 7",
        "Session 8",
        "Session 9",
      ])

      const session8 = modules.find((module) => module.canvasId === "801")
      expect(session8?.items).toEqual([
        {
          type: "File",
          title: session8SlidesTitle,
          canvasId: "502",
          resolvedPath: `files/${slugify(session8SlidesTitle, "slides")}.md`,
        },
        {
          type: "Assignment",
          title: session8AssignmentTitle,
          canvasId: "602",
          resolvedPath: `assignments/${slugify(session8AssignmentTitle, "untitled")}.md`,
        },
      ])

      // The old-form module (session 6) carries no canvas_id suffix, so
      // resolution falls back to matching the slugified title against the
      // vault filename sync would have written.
      const session6 = modules.find((module) => module.canvasId === "601m")
      const homework = session6?.items.find((item) => item.type === "Assignment")
      expect(homework?.resolvedPath).toBe(
        `assignments/${slugify(session6HomeworkTitle, "untitled")}.md`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("selectModulesForAssignment", () => {
  it("selects the assignment's own module plus the preceding module, excluding the following one", async () => {
    const root = await threeSessionVault()
    try {
      const courseRoot = coursePaths(root, course.code, course.canvasId).root
      const selection = await selectModulesForAssignment(courseRoot, {
        canvasId: "602",
        title: session8AssignmentTitle,
      })

      if (selection.mode !== "module") {
        throw new Error("Expected module selection to succeed")
      }
      expect(selection.moduleCanvasIds.sort()).toEqual(["701", "801"])
      expect(selection.paths).toEqual(
        expect.arrayContaining([
          `assignments/${slugify(session8AssignmentTitle, "untitled")}.md`,
          `files/${slugify(session8SlidesTitle, "slides")}.md`,
          `assignments/${slugify(session7HomeworkTitle, "untitled")}.md`,
          `files/${slugify(session7SlidesTitle, "slides")}.md`,
        ]),
      )
      expect(selection.paths).not.toContain(
        `assignments/${slugify(session9HomeworkTitle, "untitled")}.md`,
      )
      expect(selection.paths).not.toContain(`files/${slugify(session9SlidesTitle, "slides")}.md`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("falls back to keyword-fallback when the assignment is not referenced by any module", async () => {
    const root = await threeSessionVault()
    try {
      const courseRoot = coursePaths(root, course.code, course.canvasId).root
      const selection = await selectModulesForAssignment(courseRoot, {
        canvasId: "999",
        title: "Unreferenced assignment",
      })
      expect(selection).toEqual({ mode: "keyword-fallback" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("selectModulesForAssignment with module_canvas_id reverse links", () => {
  it("includes a manually-ingested file carrying module_canvas_id even though it is not a module item", async () => {
    const root = await threeSessionVault()
    try {
      const paths = coursePaths(root, course.code, course.canvasId)
      await mkdir(dirname(join(paths.files, "manual-exhibit.md")), { recursive: true })
      await writeFile(
        join(paths.files, "manual-exhibit.md"),
        renderVaultDocument(
          createVaultFrontmatter({
            canvasId: "manual-exhibit",
            canvasUrl: "https://canvas.example.invalid/manual-exhibit",
            type: "fixture",
            content: "Manually ingested exhibit body.",
            source: "user",
            status: "final",
            aiPolicy: "allowed",
            moduleCanvasId: "801",
          }),
          "Manually ingested exhibit body.",
        ),
        "utf8",
      )

      const courseRoot = paths.root
      const selectedForSession8 = await selectModulesForAssignment(courseRoot, {
        canvasId: "602",
        title: session8AssignmentTitle,
      })
      if (selectedForSession8.mode !== "module") {
        throw new Error("Expected module selection to succeed")
      }
      expect(selectedForSession8.paths).toContain("files/manual-exhibit.md")

      const selectedForSession9 = await selectModulesForPeriod(courseRoot, {
        kind: "session",
        value: "9",
      })
      if (selectedForSession9.mode !== "module") {
        throw new Error("Expected module selection to succeed")
      }
      expect(selectedForSession9.paths).not.toContain("files/manual-exhibit.md")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("selectModulesForPeriod", () => {
  it("selects the module whose date falls within the requested week", async () => {
    const root = await threeSessionVault()
    try {
      const courseRoot = coursePaths(root, course.code, course.canvasId).root
      const selection = await selectModulesForPeriod(courseRoot, {
        kind: "week",
        value: "2025-10-16",
      })
      if (selection.mode !== "module") {
        throw new Error("Expected module selection to succeed")
      }
      expect(selection.moduleCanvasIds).toEqual(["801"])
      expect(selection.paths).toEqual(
        expect.arrayContaining([
          `files/${slugify(session8SlidesTitle, "slides")}.md`,
          `assignments/${slugify(session8AssignmentTitle, "untitled")}.md`,
        ]),
      )
      expect(selection.paths).not.toContain(
        `assignments/${slugify(session7HomeworkTitle, "untitled")}.md`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("selects the module whose title matches a requested session number", async () => {
    const root = await threeSessionVault()
    try {
      const courseRoot = coursePaths(root, course.code, course.canvasId).root
      const selection = await selectModulesForPeriod(courseRoot, { kind: "session", value: "9" })
      if (selection.mode !== "module") {
        throw new Error("Expected module selection to succeed")
      }
      expect(selection.moduleCanvasIds).toEqual(["901"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("degrades to keyword-fallback when no module date matches the requested week", async () => {
    const root = await threeSessionVault()
    try {
      const courseRoot = coursePaths(root, course.code, course.canvasId).root
      const selection = await selectModulesForPeriod(courseRoot, {
        kind: "week",
        value: "2030-01-01",
      })
      expect(selection).toEqual({ mode: "keyword-fallback" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("selects a module with no unlock_at/session_at of its own by the due_at of an assignment it references", async () => {
    const root = await threeSessionVault()
    try {
      const paths = coursePaths(root, course.code, course.canvasId)
      const session10Title = "Session 10 Homework"
      // A module with no date signal of its own at all.
      await put(
        join(paths.modules, "10-session-10-1001", "session-10.md"),
        "1001",
        ["Session 10", "", `- Assignment: ${session10Title} (canvas_id: 604)`].join("\n"),
      )
      await put(
        join(paths.assignments, `${slugify(session10Title, "untitled")}.md`),
        "604",
        "Homework 10 prompt.",
        { due_at: "2025-10-30T00:00:00.000Z" },
      )

      const courseRoot = coursePaths(root, course.code, course.canvasId).root
      const selection = await selectModulesForPeriod(courseRoot, {
        kind: "week",
        value: "2025-10-30",
      })
      if (selection.mode !== "module") {
        throw new Error(
          "Expected module selection to succeed via the referenced assignment's due_at",
        )
      }
      expect(selection.moduleCanvasIds).toEqual(["1001"])
      expect(selection.paths).toContain(`assignments/${slugify(session10Title, "untitled")}.md`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("assembleCourseContext with module selection", () => {
  it("excludes unrelated-session keyword matches and logs the selected modules", async () => {
    const root = await threeSessionVault()
    try {
      const paths = coursePaths(root, course.code, course.canvasId)
      // A manifest whose task-string keyword scoring would otherwise admit
      // every row (mirroring the real prep/assignment task strings) —
      // module selection must suppress this entirely.
      await put(
        paths.index,
        "manifest",
        [
          "| title | type | dates | path | token estimate |",
          "| --- | --- | --- | --- | --- |",
          `| Session 9 homework | assignment | | assignments/${slugify(session9HomeworkTitle, "untitled")}.md | 20 |`,
        ].join("\n"),
      )

      const selection = await selectModulesForAssignment(paths.root, {
        canvasId: "602",
        title: session8AssignmentTitle,
      })

      const result = await assembleCourseContext({
        vaultRoot: root,
        course,
        task: "assignment session file module reading prep",
        runId: "run-module-selection",
        functionName: "assignmentDraft",
        config: config(),
        tokenBudget: 4000,
        triage: { summarize: async () => "unused" },
        selection,
      })

      expect(result.selected).toEqual(
        expect.arrayContaining([
          `assignments/${slugify(session8AssignmentTitle, "untitled")}.md`,
          `files/${slugify(session7SlidesTitle, "slides")}.md`,
        ]),
      )
      expect(result.selected).not.toContain(
        `assignments/${slugify(session9HomeworkTitle, "untitled")}.md`,
      )

      const log = (await readFile(vaultPaths(root).metadata.contextLog, "utf8")).trim().split("\n")
      const entry = JSON.parse(log.at(-1) ?? "{}")
      expect(entry.selectionMode).toBe("module")
      expect(entry.selectedModuleCanvasIds.sort()).toEqual(["701", "801"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("logs keyword-fallback when module selection finds nothing", async () => {
    const root = await threeSessionVault()
    try {
      const paths = coursePaths(root, course.code, course.canvasId)
      await put(
        paths.index,
        "manifest",
        [
          "| title | type | dates | path | token estimate |",
          "| --- | --- | --- | --- | --- |",
          `| Session 9 homework | assignment | | assignments/${slugify(session9HomeworkTitle, "untitled")}.md | 20 |`,
        ].join("\n"),
      )
      const selection = await selectModulesForAssignment(paths.root, {
        canvasId: "999",
        title: "Unreferenced assignment",
      })

      const result = await assembleCourseContext({
        vaultRoot: root,
        course,
        task: "assignment homework module",
        runId: "run-keyword-fallback",
        functionName: "assignmentDraft",
        config: config(),
        tokenBudget: 4000,
        triage: { summarize: async () => "unused" },
        selection,
      })

      expect(result.selected).toEqual([
        `assignments/${slugify(session9HomeworkTitle, "untitled")}.md`,
      ])
      const log = (await readFile(vaultPaths(root).metadata.contextLog, "utf8")).trim().split("\n")
      const entry = JSON.parse(log.at(-1) ?? "{}")
      expect(entry.selectionMode).toBe("keyword-fallback")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
