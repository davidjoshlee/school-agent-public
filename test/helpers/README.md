# test/helpers

Shared, typed test scaffolding for the school-agent test suite. These modules
centralise the fixtures that used to be inlined (and duplicated) in the
per-file test scaffolding: the msw server lifecycle, the temp-directory and
cleanup pattern, the `SchoolConfig`/`CanvasHttpClient` builders, and the
recursive vault-tree snapshot.

Every helper is imported per test file with a `.js` suffix (NodeNext ESM):

```ts
import { server, installCourseHandlers } from "./helpers/canvasMock.js"
import { client, schoolConfig } from "./helpers/schoolConfig.js"
import { temporaryDirectory } from "./helpers/tempDir.js"
import { vaultTree } from "./helpers/vaultTree.js"
```

## `canvasMock.ts` — the msw server and route handlers

- **`server`** — the single `setupServer()` instance for the importing test file.
  Importing this module registers the file-scoped `beforeAll(listen)` /
  `afterEach(resetHandlers)` / `afterAll(close)` lifecycle, so tests only add
  their own per-test `server.use(...)` overrides.
- **`installCourseHandlers(config?)`** — installs the canonical deterministic
  route handlers for the shared endpoints `courses`, `courses/:id`,
  `modules`, `assignments`, `assignments/:id/submissions/self`, `pages/:url`,
  `files`, `discussion_topics`, `quizzes`, `announcements`, and
  `calendar_events`. The default reproduces the richest baseline (course "1"
  FIN-101 with one module, two dated assignments, one announcement, one
  calendar event, one page, one file, and two own submissions).

  **Overriding routes.** Pass a `MockCourseHandlersConfig` to swap the course,
  modules, assignments, submissions, pages, files, announcements, calendar
  events, discussions, quizzes, or to make a resource return a non-2xx status:

  ```ts
  installCourseHandlers({
    course: { id: "1", name: "Pricing", course_code: "MANIFEST-101", syllabus_body: "…" },
    assignments: [{ id: "21", name: "Case memo", due_at: null, created_at: "…", all_dates: [] }],
    submissions: { "21": { id: "61", assignment_id: "21", workflow_state: "unsubmitted" } },
    forbidden: { quizzes: 403 }, // make the quizzes endpoint return HTTP 403
  })
  ```

  Tests that need a bespoke multi-course corpus (e.g. a second course that
  403s on every resource, or an ended course found only through an override)
  still add their own `server.use(...)` handlers on top; handlers registered
  later take precedence in msw.

  The committed corpus under `test/fixtures/canvas/` is validated by
  `canvas-endpoint-fixtures.test.ts`. The shared mock keeps small deterministic
  shapes rather than replaying those redacted fixtures, because the fixtures'
  redacted ids differ from the ids the sync assertions need. If a future test
  wants to replay a committed fixture, load it in the `installCourseHandlers`
  config or with a `server.use`.

## `schoolConfig.ts` — SchoolConfig and client builders

- **`schoolConfig(overrides)`** — returns a complete, typed `SchoolConfig`
  defaulted to the canonical pilot fixture shape. `vaultPath` is required;
  every other field is overridable (canvas baseUrl/tokenEnv, index path, models
  registry, AI policy, pilot course id, sync, prep granularity, etc.).
- **`defaultSchoolModels`** — the deterministic `mock/*` model registry used by
  the Canvas-sync fixtures.
- **`realSchoolModels`** — the `openai/anthropic/google` registry used by
  engine fixtures (`retrieve`, `prep`) whose assertions depend on the provider
  serving a function name.
- **`client(options?)`** — a `CanvasHttpClient` pinned to the msw origin with
  the fixture token. `reportRequestCost` is always suppressed so the suite stays
  quiet; pass `random`/`sleep` to control retry jitter (e.g.
  `client({ random: () => 0 })` for deterministic backoff).
- **`canvasBaseUrl`** — the canonical msw origin (`https://canvas.test`).

## `tempDir.ts` — temporary directories with automatic cleanup

- **`temporaryDirectory(prefix)`** — `mkdtemp(join(tmpdir(), prefix))`. The
  directory is tracked and removed automatically after each test via a
  file-scoped `afterEach`. Callers may still remove it themselves (removal is
  forced and idempotent).
- Importing this module registers the cleanup hook for the importing test file,
  so tests no longer need their own `temporaryDirectories` array + `afterEach`.

## `vaultTree.ts` — recursive vault snapshot

- **`vaultTree(root)`** — reads every `.md`/`.json` file under `root`
  recursively and returns `{ relativePath: contents }` (sorted). Used to assert
  that a rebuilt vault subtree is byte-identical.

## `onboard-fixtures.ts` — onboard-specific corpora

- **`createConfiguration()`** — writes a minimal `school.config.json` and
  returns `{ configurationPath, vaultPath, indexPath }`.
- **`installPilotHandlers(syllabus, assignments?)`** — the concluded-pilot
  Canvas corpus (course "10"/"20").
- **`installFallbackCourseHandlers({ graded, assignmentsReadable? })`** — the
  unresolved-course Canvas corpus (course "30") used by the pilot-eligibility
  tests.

## `canvasMock.test.ts`

A smoke test that proves the shared mock serves a course list, so the harness
itself has coverage.
