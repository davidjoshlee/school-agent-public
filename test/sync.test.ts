import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { Command } from "commander"
import { HttpResponse, http } from "msw"
import { describe, expect, it, vi } from "vitest"
import { CanvasSyncAuthenticationError, syncCanvas } from "../src/canvas/sync.js"
import { registerSyncCommand } from "../src/canvas/sync-cli.js"
import { fileIdsFromHtml } from "../src/canvas/sync-render.js"
import { pilotSnapshot, visibleDocuments } from "../src/engines/simulate-snapshot.js"
import { createSchoolIndex } from "../src/store/db.js"
import { parseVaultDocument } from "../src/store/vault.js"
import { installCourseHandlers, server } from "./helpers/canvasMock.js"
import { client, schoolConfig } from "./helpers/schoolConfig.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

async function markdownFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return markdownFiles(path)
        return Promise.resolve(entry.isFile() && entry.name.endsWith(".md") ? [path] : [])
      }),
    )
  ).flat()
}

async function vaultDocumentPath(courseRoot: string, canvasId: string): Promise<string> {
  for (const path of await markdownFiles(courseRoot)) {
    try {
      if (
        parseVaultDocument(await readFile(path, "utf8"), path).frontmatter.canvas_id === canvasId
      ) {
        return path
      }
    } catch {}
  }
  throw new Error(`Vault document not found for canvas_id ${canvasId}`)
}

describe("Canvas sync", () => {
  it("writes a full course, indexes it, records an oversize gap, and captures graded feedback", async () => {
    // Given: a complete read-only Canvas course served by MSW.
    installCourseHandlers()
    const vaultPath = await temporaryDirectory("school-agent-sync-vault-")
    const index = createSchoolIndex({ path: join(tmpdir(), `school-agent-sync-${Date.now()}.db`) })

    // When: the orchestrator performs a full sync.
    const report = await syncCanvas({
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 1,
      full: true,
    })

    // Then: the vault, index, audit gap, and instructor-feedback loop are populated.
    expect(report.courses[0]?.error).toBeUndefined()
    expect(report.courses[0]?.status).toBe("synced")
    expect(report.courses[0]?.gaps).toEqual([
      { canvasUrl: "https://canvas.test/files/51", reason: "oversize" },
    ])
    expect(index.counts()).toMatchObject({
      courses: 1,
      modules: 1,
      assignments: 2,
      announcements: 1,
      files: 1,
      submissions: 2,
      syncRuns: 1,
    })
    const courseRoot = join(vaultPath, "fin-101")
    await expect(
      readFile(await vaultDocumentPath(courseRoot, "21-feedback"), "utf8"),
    ).resolves.toContain("Strong synthesis")
    await expect(
      readFile(join(vaultPath, "fin-101", "_meta", "course-playbook.md"), "utf8"),
    ).resolves.toContain("Use evidence earlier.")
    index.close()
  })

  it("keeps unchanged artifacts stable and records each due-date, module, and deletion mutation once", async () => {
    // Given: one indexed course with a baseline Canvas response.
    installCourseHandlers()
    const vaultPath = await temporaryDirectory("school-agent-sync-multirun-vault-")
    const index = createSchoolIndex({
      path: join(tmpdir(), `school-agent-sync-multirun-${Date.now()}.db`),
    })
    const input = {
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 1,
    }
    await syncCanvas(input)
    const assignmentPath = await vaultDocumentPath(join(vaultPath, "fin-101"), "21")
    const baselineMtime = (await stat(assignmentPath)).mtimeMs

    // When: the unchanged payload is synchronized, then the payload mutates in three independent ways.
    const second = await syncCanvas(input)
    const unchangedMtime = (await stat(assignmentPath)).mtimeMs
    server.use(
      http.get("https://canvas.test/api/v1/courses/1/modules", () =>
        HttpResponse.json([
          {
            id: "11",
            name: "Week 1",
            position: 1,
            items: [
              { id: "111", title: "Intro", type: "Page", page_url: "intro" },
              { id: "112", title: "New item", type: "ExternalUrl" },
            ],
          },
        ]),
      ),
      http.get("https://canvas.test/api/v1/courses/1/assignments", () =>
        HttpResponse.json([
          {
            id: "21",
            name: "Case memo",
            description: "Apply the framework.",
            due_at: "2026-10-02T17:00:00Z",
            updated_at: "2026-09-02T17:00:00Z",
            all_dates: [],
            html_url: "https://canvas.test/courses/1/assignments/21",
          },
        ]),
      ),
    )
    const third = await syncCanvas(input)

    // Then: the second run does not rewrite unchanged artifacts; the third exposes exactly three changes and tombstones the missing assignment.
    expect(second.courses[0]?.changes).toEqual([])
    expect(unchangedMtime).toBe(baselineMtime)
    expect(third.courses[0]?.changes).toEqual([
      { resource: "module-item", canvasId: "11", detail: "module updated" },
      { resource: "assignment", canvasId: "21", detail: "due date changed" },
      { resource: "tombstone", canvasId: "1", detail: "1 assignment(s)" },
    ])
    expect(index.assignmentDeleted("22")).toBe(true)
    expect(index.counts().syncRuns).toBe(3)
    index.close()
  })

  it("isolates a forbidden course but aborts the entire sync for expired authentication", async () => {
    // Given: one forbidden course alongside a synchronizable course.
    installCourseHandlers()
    server.use(
      http.get("https://canvas.test/api/v1/courses", () =>
        HttpResponse.json([
          { id: "403", name: "Denied", course_code: "DENIED" },
          { id: "1", name: "Pricing", course_code: "FIN-101" },
        ]),
      ),
      http.get(
        "https://canvas.test/api/v1/courses/403/modules",
        () => new HttpResponse(null, { status: 403 }),
      ),
      http.get(
        "https://canvas.test/api/v1/courses/403/assignments",
        () => new HttpResponse(null, { status: 403 }),
      ),
      http.get("https://canvas.test/api/v1/announcements", ({ request }) => {
        return new URL(request.url).searchParams.get("context_codes[]") === "course_403"
          ? new HttpResponse(null, { status: 403 })
          : HttpResponse.json([])
      }),
      http.get("https://canvas.test/api/v1/calendar_events", ({ request }) => {
        return new URL(request.url).searchParams.get("context_codes[]") === "course_403"
          ? new HttpResponse(null, { status: 403 })
          : HttpResponse.json([{ id: "71", title: "Session 1", start_at: "2026-09-01T17:00:00Z" }])
      }),
      http.get(
        "https://canvas.test/api/v1/courses/403",
        () => new HttpResponse(null, { status: 403 }),
      ),
      http.get(
        "https://canvas.test/api/v1/courses/403/files",
        () => new HttpResponse(null, { status: 403 }),
      ),
      http.get(
        "https://canvas.test/api/v1/courses/403/discussion_topics",
        () => new HttpResponse(null, { status: 403 }),
      ),
      http.get(
        "https://canvas.test/api/v1/courses/403/quizzes",
        () => new HttpResponse(null, { status: 403 }),
      ),
    )
    const vaultPath = await temporaryDirectory("school-agent-sync-errors-vault-")
    const index = createSchoolIndex({
      path: join(tmpdir(), `school-agent-sync-errors-${Date.now()}.db`),
    })
    const input = {
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 1,
    }

    // When: Canvas first rejects the course and then rejects discovery with an expired token.
    const isolated = await syncCanvas(input)
    server.use(
      http.get(
        "https://canvas.test/api/v1/courses",
        () => new HttpResponse(null, { status: 401, headers: { "www-authenticate": "Bearer" } }),
      ),
    )

    // Then: each 403 becomes a resource-level permission gap while the healthy course completes; the typed 401 guidance aborts a later run.
    expect(isolated.courses[0]).toMatchObject({
      courseId: "403",
      status: "synced",
    })
    expect(isolated.courses[0]?.permissionGaps).toContainEqual({
      resource: "modules",
      status: 403,
      courseId: "403",
      canvasUrl: "https://canvas.test/courses/403",
    })
    expect(isolated.courses[1]).toMatchObject({ courseId: "1", status: "synced" })
    await expect(syncCanvas(input)).rejects.toBeInstanceOf(CanvasSyncAuthenticationError)
    index.close()
  })

  it("syncs accessible resources when Canvas denies quizzes for a course", async () => {
    // Given: a readable course whose quizzes endpoint is forbidden.
    installCourseHandlers()
    server.use(
      http.get(
        "https://canvas.test/api/v1/courses/1/quizzes",
        () => new HttpResponse(null, { status: 403 }),
      ),
    )
    const vaultPath = await temporaryDirectory("school-agent-sync-partial-vault-")
    const index = createSchoolIndex({
      path: join(tmpdir(), `school-agent-sync-partial-${Date.now()}.db`),
    })

    // When: the synchronizer encounters the permission-restricted resource.
    const report = await syncCanvas({
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 1,
    })

    // Then: readable modules and assignments persist while the quiz denial is an explicit gap.
    expect(report.courses[0]).toMatchObject({
      status: "synced",
      permissionGaps: [{ resource: "quizzes", status: 403 }],
    })
    await expect(
      readFile(await vaultDocumentPath(join(vaultPath, "fin-101"), "21"), "utf8"),
    ).resolves.toContain("Apply the framework.")
    index.close()
  })

  it("writes the real per-document canvas_url, not the course home, for assignments and module pages", async () => {
    // Given: a Canvas course whose assignment and module page each carry a distinct per-document URL.
    installCourseHandlers()
    const vaultPath = await temporaryDirectory("school-agent-sync-urls-vault-")
    const index = createSchoolIndex({
      path: join(tmpdir(), `school-agent-sync-urls-${Date.now()}.db`),
    })

    // When: the orchestrator performs a full sync.
    await syncCanvas({
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 1,
      full: true,
    })

    // Then: each artifact's canvas_url points at its own document rather than the course home.
    const assignment = parseVaultDocument(
      await readFile(await vaultDocumentPath(join(vaultPath, "fin-101"), "21"), "utf8"),
    )
    expect(assignment.frontmatter.canvas_url).toBe("https://canvas.test/courses/1/assignments/21")

    const page = parseVaultDocument(
      await readFile(await vaultDocumentPath(join(vaultPath, "fin-101"), "41"), "utf8"),
    )
    expect(page.frontmatter.canvas_url).toBe("https://canvas.test/courses/1/pages/intro")

    // The module container has no html_url, so it safely falls back to the course home.
    const module = parseVaultDocument(
      await readFile(await vaultDocumentPath(join(vaultPath, "fin-101"), "11"), "utf8"),
    )
    expect(module.frontmatter.canvas_url).toBe("https://canvas.test/courses/1")
    index.close()
  })

  it("writes created_at into assignment dates, but the simulator withholds visibility when the course has no other date signal to bound it", async () => {
    // Given: a Canvas assignment with no due date but a real top-level created_at, and — since
    // this fixture syncs only that one assignment — no module session_at/other due_at anywhere in
    // the course to establish a setup cutoff (simulate-visibility.ts's courseSetupCutoff).
    installCourseHandlers()
    server.use(
      http.get("https://canvas.test/api/v1/courses/1/assignments", () =>
        HttpResponse.json([
          {
            id: "23",
            name: "Midterm",
            description: "Synthesis.",
            due_at: null,
            created_at: "2026-02-18T17:00:00Z",
            unlock_at: null,
            updated_at: "2026-02-18T17:00:00Z",
            all_dates: [],
            html_url: "https://canvas.test/courses/1/assignments/23",
          },
        ]),
      ),
      http.get("https://canvas.test/api/v1/courses/1/assignments/23/submissions/self", () =>
        HttpResponse.json({ id: "63", assignment_id: "23", workflow_state: "unsubmitted" }),
      ),
    )
    const vaultPath = await temporaryDirectory("school-agent-sync-dates-vault-")
    const index = createSchoolIndex({
      path: join(tmpdir(), `school-agent-sync-dates-${Date.now()}.db`),
    })

    // When: the orchestrator performs a sync of the course.
    await syncCanvas({
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 1,
    })

    // Then: the assignment frontmatter still carries created_at (not just a null due_at) — sync's
    // job is to record the raw signal — but with no other date-bearing resource in the course, the
    // as-of clock cannot tell a genuine later addition from a bulk-setup artifact, so it withholds
    // visibility (unknown, counted, never leaked) rather than trusting created_at optimistically.
    const courseRoot = join(vaultPath, "fin-101")
    const assignmentPath = await vaultDocumentPath(courseRoot, "23")
    const assignment = parseVaultDocument(await readFile(assignmentPath, "utf8"), assignmentPath)
    expect(assignment.frontmatter.dates.due_at).toBeNull()
    expect(assignment.frontmatter.dates.created_at).toBe("2026-02-18T17:00:00Z")
    expect(assignment.frontmatter.dates.unlock_at).toBeNull()

    const snapshot = await pilotSnapshot(schoolConfig({ vaultPath }))
    const midtermPath = relative(courseRoot, assignmentPath)
    const midterm = snapshot.documents.find((entry) => entry.relativePath === midtermPath)
    expect(midterm?.visibleAt).toBeNull()
    expect(midterm?.visibilitySignal).toBe("unknown")
    expect(
      visibleDocuments(snapshot.documents, "2026-02-19").map((entry) => entry.relativePath),
    ).not.toContain(midtermPath)
    index.close()
  })

  it("syncs an ended course via --course override even though discovery does not surface it", async () => {
    // Given: Canvas discovery returns only active/concluded courses that EXCLUDE the requested
    // ended course, but that course is still readable through its own resource endpoints.
    server.use(
      http.get("https://canvas.test/api/v1/courses", () =>
        HttpResponse.json([{ id: "1", name: "Pricing", course_code: "FIN-101" }]),
      ),
      http.get("https://canvas.test/api/v1/courses/220433", () =>
        HttpResponse.json({
          id: "220433",
          name: "Data and Decisions",
          course_code: "W26-OPS-101",
          syllabus_body: "Syllabus",
        }),
      ),
      http.get("https://canvas.test/api/v1/courses/220433/modules", () =>
        HttpResponse.json([
          {
            id: "11",
            name: "Week 1",
            position: 1,
            items: [{ id: "111", title: "Intro", type: "Page", page_url: "intro" }],
          },
        ]),
      ),
      http.get("https://canvas.test/api/v1/courses/220433/assignments", () =>
        HttpResponse.json([
          {
            id: "778203",
            name: "Midterm",
            description: "Synthesis.",
            due_at: null,
            created_at: "2026-02-18T17:00:00Z",
            unlock_at: null,
            updated_at: "2026-02-18T17:00:00Z",
            all_dates: [],
            html_url: "https://canvas.test/courses/220433/assignments/778203",
          },
        ]),
      ),
      http.get("https://canvas.test/api/v1/announcements", () => HttpResponse.json([])),
      http.get("https://canvas.test/api/v1/calendar_events", () => HttpResponse.json([])),
      http.get("https://canvas.test/api/v1/courses/220433/pages/intro", () =>
        HttpResponse.json({ page_id: "41", url: "intro", title: "Intro", body: "Welcome page" }),
      ),
      http.get("https://canvas.test/api/v1/courses/220433/files", () => HttpResponse.json([])),
      http.get("https://canvas.test/api/v1/courses/220433/discussion_topics", () =>
        HttpResponse.json([]),
      ),
      http.get("https://canvas.test/api/v1/courses/220433/quizzes", () => HttpResponse.json([])),
      http.get(
        "https://canvas.test/api/v1/courses/220433/assignments/778203/submissions/self",
        () =>
          HttpResponse.json({ id: "63", assignment_id: "778203", workflow_state: "unsubmitted" }),
      ),
    )
    const vaultPath = await temporaryDirectory("school-agent-sync-override-vault-")
    const configPath = join(tmpdir(), `school.config-${Date.now()}.json`)
    await writeFile(
      configPath,
      JSON.stringify({
        ...schoolConfig({ vaultPath }),
        courses: { mode: "auto", allowlist: [], pilotCourseId: "220433" },
      }),
    )

    // When: the CLI syncs the ended course explicitly (--course 220433).
    const program = new Command()
      .name("school")
      .description("School agent CLI")
      .option("--config <path>", "path to school.config.json", configPath)
      .exitOverride()
    registerSyncCommand(program)
    vi.stubEnv("CANVAS_TOKEN", "fixture-token")
    try {
      await program.parseAsync(["node", "school", "sync", "--course", "220433"])
    } finally {
      vi.unstubAllEnvs()
    }

    // Then: the override path runs the full per-course sync so the vault gets the course written
    // (discovery alone would have matched nothing and silently no-op'd).
    const assignmentPath = await vaultDocumentPath(join(vaultPath, "w26-ops-101"), "778203")
    const assignment = parseVaultDocument(await readFile(assignmentPath, "utf8"), assignmentPath)
    expect(assignment.frontmatter.dates.created_at).toBe("2026-02-18T17:00:00Z")
    expect(assignment.frontmatter.dates.due_at).toBeNull()
  })

  it("probes the explicitly requested numeric ended-course id, not a different configured pilot", async () => {
    // Given: an explicitly requested ended course (220433) that discovery does not surface, and a
    // pilotCourseId pointing at a DIFFERENT course (888888). The old resolver probed the pilot and
    // silently synced the wrong course; the requested numeric id must win.
    server.use(
      http.get("https://canvas.test/api/v1/courses", () =>
        HttpResponse.json([{ id: "1", name: "Pricing", course_code: "FIN-101" }]),
      ),
      http.get("https://canvas.test/api/v1/courses/220433", () =>
        HttpResponse.json({
          id: "220433",
          name: "Data and Decisions",
          course_code: "W26-OPS-101",
          syllabus_body: "Syllabus",
        }),
      ),
      http.get("https://canvas.test/api/v1/courses/220433/modules", () => HttpResponse.json([])),
      http.get("https://canvas.test/api/v1/courses/220433/assignments", () =>
        HttpResponse.json([]),
      ),
      http.get("https://canvas.test/api/v1/announcements", () => HttpResponse.json([])),
      http.get("https://canvas.test/api/v1/calendar_events", () => HttpResponse.json([])),
      http.get("https://canvas.test/api/v1/courses/220433/files", () => HttpResponse.json([])),
      http.get("https://canvas.test/api/v1/courses/220433/discussion_topics", () =>
        HttpResponse.json([]),
      ),
      http.get("https://canvas.test/api/v1/courses/220433/quizzes", () => HttpResponse.json([])),
    )
    const vaultPath = await temporaryDirectory("school-agent-sync-requested-id-vault-")
    const configPath = join(tmpdir(), `school.config-requested-${Date.now()}.json`)
    await writeFile(
      configPath,
      JSON.stringify({
        ...schoolConfig({ vaultPath }),
        courses: { mode: "auto", allowlist: [], pilotCourseId: "888888" },
      }),
    )

    // When: the CLI syncs the requested ended course by numeric id.
    const program = new Command()
      .name("school")
      .description("School agent CLI")
      .option("--config <path>", "path to school.config.json", configPath)
      .exitOverride()
    registerSyncCommand(program)
    vi.stubEnv("CANVAS_TOKEN", "fixture-token")
    try {
      await program.parseAsync(["node", "school", "sync", "--course", "220433"])
    } finally {
      vi.unstubAllEnvs()
    }

    // Then: the requested course (not the decoy pilot 888888) is the one written to the vault.
    await expect(readFile(join(vaultPath, "w26-ops-101", "_index.md"), "utf8")).resolves.toContain(
      "220433",
    )
  })

  it("does not rewrite the recorded allowlist when syncing one course with --course", async () => {
    // Given: a list-mode config whose allowlist holds more than the course being synced.
    installCourseHandlers()
    server.use(
      http.get("https://canvas.test/api/v1/courses", () =>
        HttpResponse.json([{ id: "1", name: "Pricing", course_code: "FIN-101" }]),
      ),
    )
    const vaultPath = await temporaryDirectory("school-agent-sync-keep-allowlist-")
    const configPath = join(tmpdir(), `school.config-keep-${Date.now()}.json`)
    await writeFile(
      configPath,
      JSON.stringify({
        ...schoolConfig({ vaultPath }),
        courses: { mode: "list", allowlist: ["1", "99"], pilotCourseId: null },
      }),
    )
    const program = new Command()
      .name("school")
      .description("School agent CLI")
      .option("--config <path>", "path to school.config.json", configPath)
      .exitOverride()
    registerSyncCommand(program)
    vi.stubEnv("CANVAS_TOKEN", "fixture-token")
    try {
      // When: the student runs a one-off targeted sync of a single course.
      await program.parseAsync(["node", "school", "sync", "--course", "1"])
    } finally {
      vi.unstubAllEnvs()
    }

    // Then: the recorded allowlist is untouched — a targeted sync is not a selection change.
    const written = JSON.parse(await readFile(configPath, "utf8")) as {
      courses: { allowlist: string[] }
    }
    expect(written.courses.allowlist).toEqual(["1", "99"])
  })

  it("syncs only the allowlisted course when courses.mode is list, ignoring other discovered courses", async () => {
    // Given: Canvas discovers two active courses, but only one is in the recorded allowlist.
    installCourseHandlers()
    server.use(
      http.get("https://canvas.test/api/v1/courses", () =>
        HttpResponse.json([
          { id: "1", name: "Pricing", course_code: "FIN-101" },
          { id: "2", name: "Other Course", course_code: "OTH-2" },
        ]),
      ),
    )
    const vaultPath = await temporaryDirectory("school-agent-sync-allowlist-vault-")
    const configPath = join(tmpdir(), `school.config-allowlist-${Date.now()}.json`)
    await writeFile(
      configPath,
      JSON.stringify({
        ...schoolConfig({ vaultPath, files: { maxSizeMB: 1 } }),
        courses: { mode: "list", allowlist: ["1"], pilotCourseId: null },
      }),
    )

    // When: sync runs with no --course flag, deferring to the recorded allowlist.
    const program = new Command()
      .name("school")
      .description("School agent CLI")
      .option("--config <path>", "path to school.config.json", configPath)
      .exitOverride()
    registerSyncCommand(program)
    vi.stubEnv("CANVAS_TOKEN", "fixture-token")
    try {
      await program.parseAsync(["node", "school", "sync"])
    } finally {
      vi.unstubAllEnvs()
    }

    // Then: only the allowlisted course lands in the vault/index (course "2" is never fetched;
    // msw's onUnhandledRequest: "error" would fail the test if it were).
    await expect(
      readFile(join(vaultPath, "fin-101", "Resources", "Syllabus.md"), "utf8"),
    ).resolves.toContain("Syllabus")
    await expect(stat(join(vaultPath, "oth-2"))).rejects.toThrow()
    const index = createSchoolIndex({ path: join(vaultPath, "school.sqlite") })
    expect(index.counts().courses).toBe(1)
    index.close()
  })

  it("recovers module File items through the individual-file endpoint when the files collection is forbidden", async () => {
    // Given: a module with a File item and a forbidden files collection (course 220433's shape).
    const bytes = new Uint8Array(
      await readFile(new URL("./fixtures/files/synthetic.pdf", import.meta.url)),
    )
    let metadataGets = 0
    let downloads = 0
    installCourseHandlers({
      modules: [
        {
          id: "11",
          name: "Week 1",
          position: 1,
          items: [{ id: "112", title: "LabAssignment2.pdf", type: "File", content_id: "51" }],
        },
      ],
      files: [
        {
          id: "51",
          display_name: "LabAssignment2.pdf",
          url: "https://canvas.test/api/v1/files/51/download",
          size: bytes.byteLength,
          updated_at: "2026-09-01T17:00:00Z",
          content_type: "application/pdf",
        },
      ],
      forbidden: { files: 403 },
    })
    server.use(
      http.get("https://canvas.test/api/v1/courses/1/files/51", () => {
        metadataGets += 1
        return HttpResponse.json({
          id: "51",
          display_name: "LabAssignment2.pdf",
          url: "https://canvas.test/api/v1/files/51/download",
          size: bytes.byteLength,
          updated_at: "2026-09-01T17:00:00Z",
          content_type: "application/pdf",
        })
      }),
      http.get("https://canvas.test/api/v1/files/51/download", () => {
        downloads += 1
        return new HttpResponse(bytes, { headers: { "content-type": "text/plain" } })
      }),
    )
    const vaultPath = await temporaryDirectory("school-agent-sync-module-files-vault-")
    const index = createSchoolIndex({
      path: join(tmpdir(), `school-agent-sync-module-files-${Date.now()}.db`),
    })

    // When: the orchestrator syncs the course even though its files collection is denied.
    const report = await syncCanvas({
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 100,
    })

    // Then: the file is fetched per-item, downloaded, extracted, and indexed as a files/ artifact.
    expect(report.courses[0]?.status).toBe("synced")
    expect(report.courses[0]?.permissionGaps).toContainEqual({
      resource: "files",
      status: 403,
      courseId: "1",
      canvasUrl: "https://canvas.test/courses/1",
    })
    expect(metadataGets).toBe(1)
    expect(downloads).toBe(1)
    const courseRoot = join(vaultPath, "fin-101")
    const filePath = await vaultDocumentPath(courseRoot, "51")
    const fileDocument = parseVaultDocument(await readFile(filePath, "utf8"), filePath)
    expect(fileDocument.frontmatter.type).toBe("files")
    expect(fileDocument.frontmatter.canvas_url).toBe("https://canvas.test/api/v1/files/51/download")
    expect(fileDocument.content).toContain("Synthetic PDF ground truth")
    const manifest = await readFile(join(vaultPath, "fin-101", "_index.md"), "utf8")
    expect(manifest).toContain(relative(courseRoot, filePath))
    expect(manifest).toMatch(/\| files \|/)
    expect(index.counts().files).toBe(1)

    // Then: the file artifact carries its real Canvas date, but this fixture's module ("Week 1")
    // has no unlock_at/session_at and the course has no assignment due_at either, so there is no
    // structural signal to bound created_at against — the as-of clock withholds visibility rather
    // than trusting it (see simulate-visibility.ts's courseSetupCutoff).
    expect(fileDocument.frontmatter.dates.updated_at).toBe("2026-09-01T17:00:00Z")
    expect(fileDocument.frontmatter.dates.created_at).toBe("2026-09-01T17:00:00Z")
    const snapshot = await pilotSnapshot(schoolConfig({ vaultPath }))
    const fileRelativePath = relative(courseRoot, filePath)
    const fileEntry = snapshot.documents.find((entry) => entry.relativePath === fileRelativePath)
    expect(fileEntry?.visibleAt).toBeNull()
    expect(fileEntry?.visibilitySignal).toBe("unknown")
    expect(
      visibleDocuments(snapshot.documents, "2026-09-02").map((entry) => entry.relativePath),
    ).not.toContain(fileRelativePath)
    index.close()
  })

  it("a file whose Canvas url is an empty string syncs with a valid course-URL fallback, not a crash", async () => {
    // Given: a module File item whose per-file metadata GET returns url: "" (Canvas does this for
    // some files) — `file.url ?? courseUrl(...)` would leave canvasUrl as "", an invalid URL that
    // z.url() rejects on the NEXT sync's previousFileRecord() re-parse, crashing the entire course
    // sync. The fix treats an empty string as absent and falls back to the
    // course URL.
    const bytes = new Uint8Array(
      await readFile(new URL("./fixtures/files/synthetic.pdf", import.meta.url)),
    )
    let metadataGets = 0
    let downloads = 0
    installCourseHandlers({
      modules: [
        {
          id: "11",
          name: "Week 1",
          position: 1,
          items: [{ id: "112", title: "EmptyUrl.pdf", type: "File", content_id: "53" }],
        },
      ],
      files: [
        {
          id: "53",
          display_name: "EmptyUrl.pdf",
          url: "",
          size: bytes.byteLength,
          updated_at: "2026-09-01T17:00:00Z",
          content_type: "application/pdf",
        },
      ],
      forbidden: { files: 403 },
    })
    server.use(
      http.get("https://canvas.test/api/v1/courses/1/files/53", () => {
        metadataGets += 1
        return HttpResponse.json({
          id: "53",
          display_name: "EmptyUrl.pdf",
          url: "",
          size: bytes.byteLength,
          updated_at: "2026-09-01T17:00:00Z",
          content_type: "application/pdf",
        })
      }),
      // The empty `url` is still passed through verbatim as the file's downloadUrl (only
      // `canvasUrl`, used for the stored/frontmatter canvas_url, gets the course-URL fallback);
      // `client.download("")` resolves same-origin against the base URL, i.e. the site root —
      // exactly what a real Canvas instance would receive for this file. It must not be an
      // unhandled/unmocked request (which would make msw throw and falsely look like a crash).
      http.get("https://canvas.test/", () => {
        downloads += 1
        return new HttpResponse(bytes, { headers: { "content-type": "text/plain" } })
      }),
    )
    const vaultPath = await temporaryDirectory("school-agent-sync-empty-url-vault-")
    const index = createSchoolIndex({
      path: join(tmpdir(), `school-agent-sync-empty-url-${Date.now()}.db`),
    })

    // When: the orchestrator syncs the course even though the file's Canvas url is empty.
    const report = await syncCanvas({
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 100,
    })

    // Then: the sync completes (not "failed"), and the file's canvas_url falls back to the valid
    // course URL rather than storing the empty string.
    expect(report.courses[0]?.status).toBe("synced")
    expect(metadataGets).toBe(1)
    expect(downloads).toBe(1)
    const emptyFilePath = await vaultDocumentPath(join(vaultPath, "fin-101"), "53")
    const fileDocument = parseVaultDocument(await readFile(emptyFilePath, "utf8"), emptyFilePath)
    expect(fileDocument.frontmatter.type).toBe("files")
    expect(fileDocument.frontmatter.canvas_url).toBe("https://canvas.test/courses/1")
    expect(fileDocument.frontmatter.canvas_url).not.toBe("")

    // Then: a re-sync (which re-parses the stored index record via previousFileRecord) does not
    // throw or crash the course — the previously-crashing scenario now succeeds cleanly.
    const second = await syncCanvas({
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 100,
    })
    expect(second.courses[0]?.status).toBe("synced")
    index.close()
  })

  it("recovers files linked in an assignment description via the individual-file endpoint", async () => {
    // Given: an assignment whose description links a case file (no module File item points at it —
    // a synthetic assignment shape), and the file readable through the individual-file endpoint.
    const bytes = new Uint8Array(
      await readFile(new URL("./fixtures/files/synthetic.pdf", import.meta.url)),
    )
    let metadataGets = 0
    let downloads = 0
    installCourseHandlers({
      assignments: [
        {
          id: "21",
          name: "Case memo",
          description:
            '<p>Read the case. <a data-api-endpoint="https://canvas.test/api/v1/courses/1/files/777" ' +
            'href="https://canvas.test/courses/1/files/777?verifier=abc">ExampleCo Questions</a></p>',
          due_at: "2025-10-16T17:00:00Z",
          updated_at: "2026-09-01T17:00:00Z",
          all_dates: [],
          html_url: "https://canvas.test/courses/1/assignments/21",
        },
      ],
      files: [
        {
          id: "777",
          display_name: "ExampleCo Questions.pdf",
          url: "https://canvas.test/api/v1/files/777/download",
          size: bytes.byteLength,
          updated_at: "2026-09-01T17:00:00Z",
          content_type: "application/pdf",
        },
      ],
    })
    server.use(
      http.get("https://canvas.test/api/v1/courses/1/files/777", () => {
        metadataGets += 1
        return HttpResponse.json({
          id: "777",
          display_name: "ExampleCo Questions.pdf",
          url: "https://canvas.test/api/v1/files/777/download",
          size: bytes.byteLength,
          updated_at: "2026-09-01T17:00:00Z",
          content_type: "application/pdf",
        })
      }),
      http.get("https://canvas.test/api/v1/files/777/download", () => {
        downloads += 1
        return new HttpResponse(bytes, { headers: { "content-type": "text/plain" } })
      }),
    )
    const vaultPath = await temporaryDirectory("school-agent-sync-assignment-files-vault-")
    const index = createSchoolIndex({
      path: join(tmpdir(), `school-agent-sync-assignment-files-${Date.now()}.db`),
    })

    // When: the orchestrator syncs the course.
    const report = await syncCanvas({
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 100,
    })

    // Then: the description-linked file is fetched per-item, downloaded, extracted, and indexed.
    expect(report.courses[0]?.status).toBe("synced")
    expect(metadataGets).toBe(1)
    expect(downloads).toBe(1)
    const courseRoot = join(vaultPath, "fin-101")
    const filePath = await vaultDocumentPath(courseRoot, "777")
    const fileDocument = parseVaultDocument(await readFile(filePath, "utf8"), filePath)
    expect(fileDocument.frontmatter.type).toBe("files")
    expect(fileDocument.content).toContain("Synthetic PDF ground truth")
    expect(index.counts().files).toBeGreaterThanOrEqual(1)

    // Then: the artifact carries a real date signal — the file's own updated_at here, which
    // fileArtifactDates prefers over the assignment-date fallback — so the as-of clock stages it,
    // visible on/after that day and hidden before it.
    expect(fileDocument.frontmatter.dates.updated_at).toBe("2026-09-01T17:00:00Z")
    const snapshot = await pilotSnapshot(schoolConfig({ vaultPath }))
    const fileRelativePath = relative(courseRoot, filePath)
    const fileEntry = snapshot.documents.find((entry) => entry.relativePath === fileRelativePath)
    expect(fileEntry?.visibleAt).toBe("2026-09-01")
    expect(
      visibleDocuments(snapshot.documents, "2026-09-02").map((entry) => entry.relativePath),
    ).toContain(fileRelativePath)
    expect(
      visibleDocuments(snapshot.documents, "2026-08-31").map((entry) => entry.relativePath),
    ).not.toContain(fileRelativePath)
    index.close()
  })

  it("falls back to the file's own updated_at for created_at when the assignment-linked file has none", async () => {
    // Given: an assignment with known due_at/created_at date signals, linking a file whose
    // getFile metadata carries updated_at but no created_at of its own (unlike the sibling test
    // above's file, which is otherwise the same shape) — the case where fileArtifactDates must
    // fall back to the file's own updated_at rather than the assignment's date signals.
    const bytes = new Uint8Array(
      await readFile(new URL("./fixtures/files/synthetic.pdf", import.meta.url)),
    )
    let metadataGets = 0
    let downloads = 0
    installCourseHandlers({
      assignments: [
        {
          id: "22",
          name: "Case memo 2",
          description:
            '<p>Read the case. <a data-api-endpoint="https://canvas.test/api/v1/courses/1/files/778" ' +
            'href="https://canvas.test/courses/1/files/778?verifier=abc">Second Case Questions</a></p>',
          due_at: "2025-11-01T17:00:00Z",
          created_at: "2025-08-01T00:00:00Z",
          updated_at: "2026-09-01T17:00:00Z",
          all_dates: [],
          html_url: "https://canvas.test/courses/1/assignments/22",
        },
      ],
      files: [
        {
          id: "778",
          display_name: "Second Case Questions.pdf",
          url: "https://canvas.test/api/v1/files/778/download",
          size: bytes.byteLength,
          updated_at: "2026-09-05T12:00:00Z",
          content_type: "application/pdf",
        },
      ],
    })
    server.use(
      http.get("https://canvas.test/api/v1/courses/1/files/778", () => {
        metadataGets += 1
        return HttpResponse.json({
          id: "778",
          display_name: "Second Case Questions.pdf",
          url: "https://canvas.test/api/v1/files/778/download",
          size: bytes.byteLength,
          updated_at: "2026-09-05T12:00:00Z",
          content_type: "application/pdf",
        })
      }),
      http.get("https://canvas.test/api/v1/files/778/download", () => {
        downloads += 1
        return new HttpResponse(bytes, { headers: { "content-type": "text/plain" } })
      }),
    )
    const vaultPath = await temporaryDirectory("school-agent-sync-assignment-files-fallback-vault-")
    const index = createSchoolIndex({
      path: join(tmpdir(), `school-agent-sync-assignment-files-fallback-${Date.now()}.db`),
    })

    // When: the orchestrator syncs the course.
    const report = await syncCanvas({
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 100,
    })

    // Then: the description-linked file is still fetched and written despite carrying no
    // created_at of its own.
    expect(report.courses[0]?.status).toBe("synced")
    expect(metadataGets).toBe(1)
    expect(downloads).toBe(1)
    const secondFilePath = await vaultDocumentPath(join(vaultPath, "fin-101"), "778")
    const fileDocument = parseVaultDocument(await readFile(secondFilePath, "utf8"), secondFilePath)

    // Then: fileArtifactDates() resolves created_at from the file's own updated_at (it never had
    // one of its own), not from the assignment's created_at — the file's own date signal always
    // wins over the assignment fallback once it resolves a created_at.
    expect(fileDocument.frontmatter.dates.created_at).toBe("2026-09-05T12:00:00Z")
    expect(fileDocument.frontmatter.dates.updated_at).toBe("2026-09-05T12:00:00Z")
    index.close()
  })

  it("recovers files linked in a module page body and in the syllabus body", async () => {
    // Given: a session page (a synthetic page shape — a case PDF linked from the page body,
    // with no module File item pointing at it) and a syllabus whose body links a second file.
    const bytes = new Uint8Array(
      await readFile(new URL("./fixtures/files/synthetic.pdf", import.meta.url)),
    )
    let pageFileGets = 0
    let pageFileDownloads = 0
    let syllabusFileGets = 0
    let syllabusFileDownloads = 0
    installCourseHandlers({
      course: {
        id: "1",
        name: "Pricing",
        course_code: "FIN-101",
        syllabus_body:
          '<p>See exhibits. <a href="https://canvas.test/courses/1/files/902?verifier=abc">Syllabus exhibit</a></p>',
      },
      pages: {
        intro: {
          page_id: "41",
          url: "intro",
          title: "Intro",
          body:
            '<p>Read the case. <a data-api-endpoint="https://canvas.test/api/v1/courses/1/files/901" ' +
            'href="https://canvas.test/courses/1/files/901?verifier=abc">ExampleWorks Questions</a></p>',
        },
      },
      files: [],
    })
    server.use(
      http.get("https://canvas.test/api/v1/courses/1/files/901", () => {
        pageFileGets += 1
        return HttpResponse.json({
          id: "901",
          display_name: "ExampleWorks Questions.pdf",
          url: "https://canvas.test/api/v1/files/901/download",
          size: bytes.byteLength,
          updated_at: "2026-09-01T17:00:00Z",
          content_type: "application/pdf",
        })
      }),
      http.get("https://canvas.test/api/v1/files/901/download", () => {
        pageFileDownloads += 1
        return new HttpResponse(bytes, { headers: { "content-type": "text/plain" } })
      }),
      http.get("https://canvas.test/api/v1/courses/1/files/902", () => {
        syllabusFileGets += 1
        return HttpResponse.json({
          id: "902",
          display_name: "Syllabus Exhibit.pdf",
          url: "https://canvas.test/api/v1/files/902/download",
          size: bytes.byteLength,
          updated_at: "2026-09-01T17:00:00Z",
          content_type: "application/pdf",
        })
      }),
      http.get("https://canvas.test/api/v1/files/902/download", () => {
        syllabusFileDownloads += 1
        return new HttpResponse(bytes, { headers: { "content-type": "text/plain" } })
      }),
    )
    const vaultPath = await temporaryDirectory("school-agent-sync-page-syllabus-files-vault-")
    const index = createSchoolIndex({
      path: join(tmpdir(), `school-agent-sync-page-syllabus-files-${Date.now()}.db`),
    })

    // When: the orchestrator syncs the course.
    const report = await syncCanvas({
      client: client(),
      canvasBaseUrl: "https://canvas.test",
      vaultPath,
      index,
      gitInit: false,
      maxFileSizeMB: 100,
    })

    // Then: both the page-linked and syllabus-linked files are fetched per-item, downloaded,
    // extracted into the vault, and counted in the index.
    expect(report.courses[0]?.status).toBe("synced")
    expect(pageFileGets).toBe(1)
    expect(pageFileDownloads).toBe(1)
    expect(syllabusFileGets).toBe(1)
    expect(syllabusFileDownloads).toBe(1)
    const courseRoot = join(vaultPath, "fin-101")
    const pageFilePath = await vaultDocumentPath(courseRoot, "901")
    const pageFileDocument = parseVaultDocument(await readFile(pageFilePath, "utf8"), pageFilePath)
    expect(pageFileDocument.frontmatter.type).toBe("files")
    expect(pageFileDocument.content).toContain("Synthetic PDF ground truth")
    const syllabusFilePath = await vaultDocumentPath(courseRoot, "902")
    const syllabusFileDocument = parseVaultDocument(
      await readFile(syllabusFilePath, "utf8"),
      syllabusFilePath,
    )
    expect(syllabusFileDocument.frontmatter.type).toBe("files")
    expect(syllabusFileDocument.content).toContain("Synthetic PDF ground truth")
    expect(index.counts().files).toBeGreaterThanOrEqual(2)
    index.close()
  })
})

describe("fileIdsFromHtml", () => {
  it("extracts deduped file ids from data-api-endpoint links, plain hrefs, and download URLs", () => {
    const description =
      '<a data-api-endpoint="https://canvas.test/api/v1/courses/1/files/777" ' +
      'href="https://canvas.test/courses/1/files/777?verifier=abc">Questions</a> ' +
      '<a href="https://canvas.test/courses/1/files/888/download">Case</a> ' +
      '<a href="https://canvas.test/courses/1/files/777">Questions again</a>'
    expect(fileIdsFromHtml(description)).toEqual(["777", "888"])
  })

  it("returns an empty array for null, undefined, and empty html", () => {
    expect(fileIdsFromHtml(null)).toEqual([])
    expect(fileIdsFromHtml(undefined)).toEqual([])
    expect(fileIdsFromHtml("")).toEqual([])
  })
})
