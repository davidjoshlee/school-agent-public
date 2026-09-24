# src/canvas

Everything that talks to Canvas: the read-only HTTP client, the domain-typed
endpoint calls built on it, and the sync/onboard pipelines that turn Canvas
data into the local vault.

**Convention**: for a given command, `x.ts` holds the logic and `x-cli.ts` is
a thin `register<Name>Command(program)` wrapper — a Commander adapter that
parses flags, calls into `x.ts`, and wires the command into `src/cli.ts`. The
`x.ts` files have no dependency on Commander; the `x-cli.ts` files hold no
business logic.

Pipeline order (this repo overall): sync → retrieve → prep/draft → simulate →
compare → gate. This directory implements `sync` and `onboard` (which itself
runs an initial `sync`).

## HTTP / domain client

- `http.ts` — the read-only Canvas HTTP core: pagination, rate-limit/retry handling, token refresh, and the hard `WriteAttemptError` guard against any non-GET request.
- `endpoints.ts` — typed wrapper functions (`listCourses`, `listAssignments`, `getSyllabus`, etc.) over `http.ts`, one per Canvas resource.
- `endpoint-schemas.ts` — zod schemas validating the raw JSON shapes `endpoints.ts` parses.
- `auth.ts` — token resolution/verification, keychain storage, and auth-metadata (mint/expiry) persistence.
- `files.ts` — per-file download/hash handling for Canvas file attachments, including the pre-signed-verifier-URL path for files with the Files tab disabled.
- `read-routes.ts` — the static table of every Canvas GET route the app uses, asserted read-only by a route-table test.

## Sync

- `sync.ts` — top-level `syncCanvas` orchestration: iterates courses, calls `syncCourse`, aggregates the sync report.
- `sync-course.ts` — per-course sync: fetches each Canvas resource type and hands it to the vault writer.
- `sync-resources.ts` — resource-specific sync helpers (modules, files, discussions, etc.) factored out of `sync-course.ts`.
- `sync-render.ts` — renders fetched Canvas objects into vault Markdown/frontmatter document bodies.
- `sync-session-date.ts` — parses a course/module's session date (e.g. "Session 8") out of titles for ordering and the as-of clock.
- `sync-navigation.ts` — pure navigation model, conservative Prep/Materials/Other classification,
  calendar-week or milestone grouping, and `00 Home.md`/`00 Overview.md` Markdown rendering.
- `sync-types.ts` — shared types for sync input/report/status/permission-gap across `sync.ts` and `sync-course.ts`.
- `sync-cli.ts` — `register` wrapper exposing `sync` and `audit` on the CLI.

### Navigation writer seam

`buildNavigationModel` accepts normalized document records (including their
relative vault path and existing frontmatter `dates`) and
`navigationArtifacts` returns the home page plus one overview per populated
period. The v2 vault writer should call this after all course artifacts have
been written, adapting its document index/frontmatter rows into
`NavigationDocument` records and persisting each returned `{ path, content }`.
The navigation module intentionally does not import the path vocabulary or
write files, so it remains usable while the v2 layout is migrated and stays
free of network dependencies in tests.

## Onboard

- `onboard.ts` — pilot course selection and backfill sync, including own-submission fetch, for a newly onboarded course.
- `onboard-eligibility.ts` — live-probe fallback that lets an ended course with no active enrollment still qualify for piloting.
- `onboard-cli.ts` — `register` wrapper exposing `courses list` and `onboard`.

## CLI-only / misc

- `ingest-cli.ts` — CLI command for manually ingesting a local file into the vault outside the Canvas sync path.
- `auth-cli.ts` — `register` wrapper exposing `auth verify|status|login`.
- `fixtures.ts` — test-fixture secret scanning/redaction (`scanFixtureSecrets`, `redactCanvasFixture`) used by the HTTP layer's fixture recording and by tests.
