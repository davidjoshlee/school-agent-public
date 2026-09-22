import type Database from "better-sqlite3"
import { z } from "zod"

const migrationVersionSchema = z.object({ version: z.number().int().nonnegative() })
const schemaVersion = 5

const schemaSql = `
CREATE TABLE IF NOT EXISTS courses (
  canvas_id TEXT PRIMARY KEY,
  name TEXT,
  course_code TEXT,
  workflow_state TEXT,
  vault_path TEXT
);
CREATE TABLE IF NOT EXISTS modules (
  canvas_id TEXT PRIMARY KEY,
  course_canvas_id TEXT NOT NULL,
  name TEXT,
  position INTEGER,
  vault_path TEXT
);
CREATE TABLE IF NOT EXISTS module_items (
  canvas_id TEXT PRIMARY KEY,
  module_canvas_id TEXT NOT NULL,
  course_canvas_id TEXT NOT NULL,
  title TEXT,
  item_type TEXT,
  content_canvas_id TEXT
);
CREATE TABLE IF NOT EXISTS assignments (
  canvas_id TEXT PRIMARY KEY,
  course_canvas_id TEXT NOT NULL,
  name TEXT,
  due_at TEXT,
  vault_path TEXT,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
);
CREATE TABLE IF NOT EXISTS assignment_dates (
  canvas_id TEXT PRIMARY KEY,
  assignment_canvas_id TEXT NOT NULL,
  due_at TEXT,
  is_user_override INTEGER NOT NULL CHECK (is_user_override IN (0, 1))
);
CREATE TABLE IF NOT EXISTS announcements (
  canvas_id TEXT PRIMARY KEY,
  course_canvas_id TEXT NOT NULL,
  title TEXT,
  posted_at TEXT,
  vault_path TEXT
);
CREATE TABLE IF NOT EXISTS calendar_events (
  canvas_id TEXT PRIMARY KEY,
  course_canvas_id TEXT NOT NULL,
  title TEXT,
  start_at TEXT
);
CREATE TABLE IF NOT EXISTS files (
  canvas_id TEXT PRIMARY KEY,
  course_canvas_id TEXT NOT NULL,
  display_name TEXT,
  url TEXT,
  vault_path TEXT
);
CREATE TABLE IF NOT EXISTS submissions (
  canvas_id TEXT PRIMARY KEY,
  assignment_canvas_id TEXT NOT NULL,
  course_canvas_id TEXT NOT NULL,
  workflow_state TEXT,
  submitted_at TEXT
);
CREATE TABLE IF NOT EXISTS sync_runs (
  canvas_id TEXT PRIMARY KEY,
  course_canvas_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS token_usage (
  sync_run_canvas_id TEXT NOT NULL,
  model TEXT NOT NULL,
  function_name TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT '',
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  generation_id TEXT,
  cost_source TEXT,
  PRIMARY KEY (sync_run_canvas_id, model, function_name)
);
CREATE TABLE IF NOT EXISTS kv_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export class IndexSchemaError extends Error {
  readonly name = "IndexSchemaError"

  constructor(readonly version: number) {
    super(`SQLite index schema version ${version} is newer than this school-agent build.`)
  }
}

export function migrateIndex(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)")
  const version = currentMigrationVersion(db)
  if (version > schemaVersion) {
    throw new IndexSchemaError(version)
  }
  if (version === 0) {
    db.transaction(() => {
      db.exec(schemaSql)
      db.prepare("INSERT INTO migrations (version) VALUES (?)").run(schemaVersion)
    })()
    return
  }
  db.transaction(() => {
    if (version < 2) {
      db.exec(
        "ALTER TABLE assignments ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))",
      )
      db.prepare("INSERT INTO migrations (version) VALUES (?)").run(2)
    }
    if (version < 3) {
      db.exec(
        "CREATE TABLE IF NOT EXISTS calendar_events (canvas_id TEXT PRIMARY KEY, course_canvas_id TEXT NOT NULL, title TEXT, start_at TEXT)",
      )
      db.prepare("INSERT INTO migrations (version) VALUES (?)").run(3)
    }
    if (version < 4) {
      db.exec("ALTER TABLE token_usage ADD COLUMN recorded_at TEXT NOT NULL DEFAULT ''")
      db.exec("ALTER TABLE token_usage ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0")
      db.prepare("INSERT INTO migrations (version) VALUES (?)").run(4)
    }
    if (version < 5) {
      // Nullable: old rows get NULL (no gateway generation id captured yet,
      // cost source unknown — treated as "estimate" everywhere it's read).
      db.exec("ALTER TABLE token_usage ADD COLUMN generation_id TEXT")
      db.exec("ALTER TABLE token_usage ADD COLUMN cost_source TEXT")
      db.prepare("INSERT INTO migrations (version) VALUES (?)").run(5)
    }
  })()
}

export function currentMigrationVersion(db: Database): number {
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM migrations").get()
  return migrationVersionSchema.parse(row).version
}
