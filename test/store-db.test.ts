import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { createSchoolIndex } from "../src/store/db.js"
import { currentMigrationVersion, migrateIndex } from "../src/store/db-schema.js"

const fixtureSnapshot = {
  course: {
    canvasId: "course-1",
    name: "Leadership Lab",
    courseCode: "COURSE-101",
    workflowState: "available",
    vaultPath: "leadership-lab",
  },
  modules: [
    {
      canvasId: "module-1",
      courseCanvasId: "course-1",
      name: "Week 1",
      position: 1,
      vaultPath: "leadership-lab/modules/01-week-1",
      items: [
        {
          canvasId: "module-item-1",
          title: "Read the case",
          itemType: "File",
          contentCanvasId: "file-1",
        },
      ],
    },
  ],
  assignments: [
    {
      canvasId: "assignment-1",
      courseCanvasId: "course-1",
      name: "Reflection",
      dueAt: "2026-10-15T23:59:00Z",
      vaultPath: "leadership-lab/assignments/reflection.md",
      allDates: [
        {
          canvasId: "assignment-date-1",
          dueAt: "2026-10-16T23:59:00Z",
          isUserOverride: true,
        },
      ],
    },
  ],
  announcements: [
    {
      canvasId: "announcement-1",
      courseCanvasId: "course-1",
      title: "Welcome",
      postedAt: "2026-09-01T12:00:00Z",
      vaultPath: "leadership-lab/announcements/welcome.md",
    },
  ],
  files: [
    {
      canvasId: "file-1",
      courseCanvasId: "course-1",
      displayName: "case.pdf",
      url: "https://canvas.example.test/files/1/download",
      vaultPath: "leadership-lab/files/case.pdf",
    },
  ],
  submissions: [
    {
      canvasId: "submission-1",
      assignmentCanvasId: "assignment-1",
      courseCanvasId: "course-1",
      workflowState: "submitted",
      submittedAt: "2026-10-14T12:00:00Z",
    },
  ],
  syncRun: {
    canvasId: "sync-1",
    courseCanvasId: "course-1",
    startedAt: "2026-09-01T12:00:00Z",
    completedAt: "2026-09-01T12:01:00Z",
    status: "completed",
  },
  tokenUsage: [
    {
      syncRunCanvasId: "sync-1",
      model: "gpt-5",
      functionName: "extractSummary",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
    },
  ],
  metadata: [{ key: "last_sync", value: "2026-09-01T12:01:00Z" }],
} as const

describe("school SQLite index", () => {
  it("creates every current table when opened against an empty database", () => {
    // Given: an empty SQLite database.
    const index = createSchoolIndex({ path: ":memory:" })

    // When: migrations run during index creation.
    const migrationVersion = index.migrationVersion()

    // Then: the first schema migration and each index table are available.
    expect(migrationVersion).toBe(5)
    expect(index.counts()).toEqual({
      courses: 0,
      modules: 0,
      moduleItems: 0,
      assignments: 0,
      assignmentDates: 0,
      announcements: 0,
      calendarEvents: 0,
      files: 0,
      submissions: 0,
      syncRuns: 0,
      tokenUsage: 0,
      kvMeta: 0,
    })
    index.close()
  })

  it("indexes a fixture snapshot with idempotent canvas-id upserts", () => {
    // Given: an empty index and a representative Canvas snapshot.
    const index = createSchoolIndex({ path: ":memory:" })

    // When: the same snapshot is applied twice.
    index.applySnapshot(fixtureSnapshot)
    index.applySnapshot(fixtureSnapshot)

    // Then: every entity is represented once rather than duplicated.
    expect(index.counts()).toEqual({
      courses: 1,
      modules: 1,
      moduleItems: 1,
      assignments: 1,
      assignmentDates: 1,
      announcements: 1,
      calendarEvents: 0,
      files: 1,
      submissions: 1,
      syncRuns: 1,
      tokenUsage: 1,
      kvMeta: 1,
    })
    index.close()
  })

  it("resolves the same course by Canvas id or by course code, and returns null for neither", () => {
    // Given: an index holding one course.
    const index = createSchoolIndex({ path: ":memory:" })
    index.applySnapshot(fixtureSnapshot)

    // When/Then: both lookup forms find the same course.
    expect(index.courseByCanvasId("course-1")).toEqual({
      canvasId: "course-1",
      courseCode: "COURSE-101",
    })
    expect(index.courseByCode("COURSE-101")).toEqual({
      canvasId: "course-1",
      courseCode: "COURSE-101",
    })

    // And: an unrecognized value matches neither.
    expect(index.courseByCanvasId("nope")).toBeNull()
    expect(index.courseByCode("nope")).toBeNull()
    index.close()
  })

  it("prefers a personal override and places assignments without a due date in the undated bucket", () => {
    // Given: a snapshot with an override and an assignment whose base due date is null.
    const index = createSchoolIndex({ path: ":memory:" })
    index.applySnapshot(fixtureSnapshot)
    index.upsertAssignment({
      canvasId: "assignment-undated",
      courseCanvasId: "course-1",
      name: "Optional reflection",
      dueAt: null,
      vaultPath: "leadership-lab/assignments/optional-reflection.md",
      allDates: [],
    })

    // When: effective due dates are resolved.
    const overridden = index.effectiveDueDate("assignment-1")
    const undated = index.effectiveDueDate("assignment-undated")

    // Then: the personal override wins, while null safely maps to the undated bucket.
    expect(overridden).toEqual({ bucket: "dated", dueAt: "2026-10-16T23:59:00Z" })
    expect(undated).toEqual({ bucket: "undated", dueAt: null })
    index.close()
  })

  it("stores file metadata and vault-relative paths without file content", () => {
    // Given: an empty index and a file record with metadata only.
    const index = createSchoolIndex({ path: ":memory:" })
    index.applySnapshot(fixtureSnapshot)

    // When: the indexed file metadata is read back.
    const file = index.fileMetadata("file-1")

    // Then: it contains metadata and a relative vault path, but no text or bytes.
    expect(file).toEqual({
      canvasId: "file-1",
      courseCanvasId: "course-1",
      displayName: "case.pdf",
      url: "https://canvas.example.test/files/1/download",
      vaultPath: "leadership-lab/files/case.pdf",
    })
    expect(() =>
      index.upsertFile({
        ...fixtureSnapshot.files[0],
        content: "private case text must remain in the vault",
      }),
    ).toThrow(z.ZodError)
    index.close()
  })
})

describe("token_usage schema migration (v3 -> v5)", () => {
  it("adds recorded_at/cached_input_tokens (v4) and generation_id/cost_source (v5) to a pre-existing v3 database, defaulting existing rows", () => {
    // Given: a raw v3-shaped database (no recorded_at / cached_input_tokens columns).
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE token_usage (
        sync_run_canvas_id TEXT NOT NULL,
        model TEXT NOT NULL,
        function_name TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        PRIMARY KEY (sync_run_canvas_id, model, function_name)
      );
      CREATE TABLE migrations (version INTEGER PRIMARY KEY);
    `)
    db.prepare(
      "INSERT INTO token_usage (sync_run_canvas_id, model, function_name, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("run-1", "mock/model", "prepBrief", 10, 5, 0.1)
    db.prepare("INSERT INTO migrations (version) VALUES (?)").run(3)

    // When: the current migration runs against it.
    migrateIndex(db)

    // Then: the schema is at v5 (v4 + v5 both apply from a v3 base), and the
    // pre-existing row got the documented defaults.
    expect(currentMigrationVersion(db)).toBe(5)
    const columns = z
      .array(z.object({ name: z.string() }))
      .parse(db.prepare("PRAGMA table_info(token_usage)").all())
      .map((column) => column.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        "recorded_at",
        "cached_input_tokens",
        "generation_id",
        "cost_source",
      ]),
    )
    const row = db
      .prepare(
        "SELECT recorded_at, cached_input_tokens, generation_id, cost_source FROM token_usage WHERE sync_run_canvas_id = ?",
      )
      .get("run-1")
    expect(row).toEqual({
      recorded_at: "",
      cached_input_tokens: 0,
      generation_id: null,
      cost_source: null,
    })
    db.close()
  })
})

describe("SchoolIndex.costSummary", () => {
  it("groups token usage by function and model, splitting cached vs total input tokens", () => {
    // Given: usage rows spanning two functions/models, one with cached tokens.
    const index = createSchoolIndex({ path: ":memory:" })
    index.upsertTokenUsage({
      syncRunCanvasId: "run-1",
      model: "mock/model-a",
      functionName: "prepBrief",
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
      recordedAt: "2026-09-01T00:00:00.000Z",
      costUsd: 0.5,
    })
    index.upsertTokenUsage({
      syncRunCanvasId: "run-2",
      model: "mock/model-a",
      functionName: "prepBrief",
      inputTokens: 200,
      outputTokens: 80,
      cachedInputTokens: 0,
      recordedAt: "2026-09-02T00:00:00.000Z",
      costUsd: 1,
    })
    index.upsertTokenUsage({
      syncRunCanvasId: "run-3",
      model: "mock/model-b",
      functionName: "assignmentDraft",
      inputTokens: 300,
      outputTokens: 100,
      cachedInputTokens: 50,
      recordedAt: "2026-09-03T00:00:00.000Z",
      costUsd: 2,
    })

    // When: the summary is queried with no window.
    const summary = index.costSummary()

    // Then: rows are grouped by (function, model) with correct sums, plus a grand total.
    expect(summary.groups).toEqual([
      {
        functionName: "assignmentDraft",
        model: "mock/model-b",
        inputTokens: 300,
        outputTokens: 100,
        cachedInputTokens: 50,
        costUsd: 2,
        costSource: "estimate",
      },
      {
        functionName: "prepBrief",
        model: "mock/model-a",
        inputTokens: 300,
        outputTokens: 130,
        cachedInputTokens: 20,
        costUsd: 1.5,
        costSource: "estimate",
      },
    ])
    expect(summary.totalInputTokens).toBe(600)
    expect(summary.totalOutputTokens).toBe(230)
    expect(summary.totalCachedInputTokens).toBe(70)
    expect(summary.totalCostUsd).toBeCloseTo(3.5, 10)
    index.close()
  })

  it("excludes rows older than `since` and undated ('') rows when a window is given", () => {
    // Given: an undated legacy row, an older-month row, and a current-month row.
    const index = createSchoolIndex({ path: ":memory:" })
    index.upsertTokenUsage({
      syncRunCanvasId: "run-legacy",
      model: "mock/model-a",
      functionName: "prepBrief",
      inputTokens: 999,
      outputTokens: 999,
      cachedInputTokens: 0,
      costUsd: 999,
    })
    index.upsertTokenUsage({
      syncRunCanvasId: "run-old",
      model: "mock/model-a",
      functionName: "prepBrief",
      inputTokens: 50,
      outputTokens: 50,
      cachedInputTokens: 0,
      recordedAt: "2026-08-15T00:00:00.000Z",
      costUsd: 0.5,
    })
    index.upsertTokenUsage({
      syncRunCanvasId: "run-current",
      model: "mock/model-a",
      functionName: "prepBrief",
      inputTokens: 10,
      outputTokens: 10,
      cachedInputTokens: 0,
      recordedAt: "2026-09-15T00:00:00.000Z",
      costUsd: 0.1,
    })

    // When: the summary is windowed to the current month.
    const summary = index.costSummary({ since: "2026-09-01T00:00:00.000Z" })

    // Then: only the current-month row contributes.
    expect(summary.groups).toEqual([
      {
        functionName: "prepBrief",
        model: "mock/model-a",
        inputTokens: 10,
        outputTokens: 10,
        cachedInputTokens: 0,
        costUsd: 0.1,
        costSource: "estimate",
      },
    ])
    index.close()
  })
})
