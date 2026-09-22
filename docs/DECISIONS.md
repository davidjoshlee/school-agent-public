# Decisions — school-agent

Condensed from the full engineering log (git history has the original: `docs/ENGINEERING-LOG.md`
through commit 69502fb). Only decisions and defect lessons still load-bearing for someone touching
sync / simulate / retrieve / the engines. See CLAUDE.md "Key decisions" for the shortest version of
the most load-bearing ones (files, as-of clock, budget-aware retrieval, pilot-eligibility fallback,
`sync --course`, draft gate protocol) — this file adds the ones that didn't fit there.

## File recovery is generic across every HTML surface

Canvas links files as `/files/<id>` inside module items, assignment descriptions, page bodies, AND
the syllabus body — a case's questions PDF can live on any of these. `fileIdsFromHtml` (generic
extractor, renamed from the assignment-only `assignmentFileIds`) + a shared `recoverFileById`
helper (getFile → 403/404 records a permission gap → `syncFileRecord`) back `syncModuleFiles`,
`syncAssignmentFiles`, `syncPageFiles`, and `syncSyllabusFiles`. When a draft looks like it's
missing source material, check whether the reference lives in a page/syllabus body, not just the
module or assignment.

## Canvas file JSON uses `content-type` (hyphen), not `content_type`

`FileSchema` carries a `.transform()` that normalizes the hyphenated key onto the canonical
`content_type` at parse time (`.passthrough()` keeps the raw value too). Any new code reading a
Canvas File object's content type must go through `FileSchema`, not the raw JSON key.

## File download follows the redirect but drops the Authorization header

The file JSON `url` (verifier) 307-redirects cross-origin to a CDN
(`cdn.inst-fs-iad-prod.inscloudgate.net`). `CanvasHttpClient.download()` uses
`fetch(url, { redirect: "follow" })` with **no** Authorization header — the verifier URL is
self-authenticating, and sending the Bearer token to a third-party CDN would leak it. `/files/:id/download`
404s for courses like this; never use it, and never construct a `verifier=` param by hand (both are
grep-tested).

## Visibility is structural: `simulate-visibility.ts`, not a bare date-key lookup

Precedence: own `unlock_at`/`posted_at` → containing module's release (`unlock_at`, else
`session_at` − 7 days) → own `due_at` → own `created_at` only when later than the course-setup
cutoff → `unknown`. The 2026-09-02 fix: Canvas creates most assignments/files at course setup, so
the old `created_at` fallback made sessions 10–18 "visible" on 2025-10-16 while still reporting
leakage 0. `report.json` now records `visibility.bySignal` so that class of looseness is visible.
`fileArtifactDates` still writes `created_at ?? updated_at` under `created_at` (leak-safe).

## Retrieval: assignment-linked files are admitted before keyword selection

`assembleCourseContext` (`retrieve.ts`) resolves the assignment's own linked files
(`/files/<id>` refs matched to synced `files/*.md` frontmatter `canvas_id`) as `priorityPaths` and
admits them before the keyword-scored loop runs, so a large-but-directly-relevant case doesn't lose
a budget race to smaller unrelated matches. An oversized priority file is admitted as its
`summaryFor` summary rather than skipped outright (still respects the budget). This sits on top of
the budget-aware skip-before-read described in CLAUDE.md; it does not change `selectEntries` or the
truncation backstop.

## Draft engine escalates instead of fabricating

`externalSourceReferences()` (assignment.ts) detects non-Canvas links in the assignment body
(unwrapping `urldefense` redirect wrappers). When present, `draftPrompt`/`revisePrompt` forbid
inventing figures/exhibits/dataset values not present in the supplied Materials; the draft must
lead with a `## Missing required sources` banner naming what's needed and mark each dependent
answer `PENDING — requires <source>`. The self-review (`assignment-review.ts`) treats a fabricated
quantitative value as a defect and checks for the PENDING/banner posture. A review failure still
degrades to an explicit "unverified" note rather than blocking — the review is a model self-check,
not a blocking gate.

## Module-scoped simulation matches by slug, not by date window alone

`--module <canvas-id>` on `simulate` (via `moduleAssignmentDocuments` in `simulate-snapshot.ts`)
finds the module doc across the whole snapshot, slug-matches its `- Assignment: <title>` lines to
`assignments/<slug>.md` using the same `slugify` the writer used, then intersects with the visible
set. This exists because a single as-of date can make many unrelated assignments visible at once
(the stock due-date chain); narrowing by module keeps a simulation run to the material a professor
would actually be covering that week. The as-of clock / leakage contract is untouched — this only
narrows which visible docs get drafted.

## `school gate m1` creates its own top-level `gate` command

Before the M0 gate subsystem was retired, `registerGateM1Command` assumed `gate m0` had already run
and registered the shared `gate` parent command, and threw if it hadn't. Now that `gate m0` is gone,
`registerGateM1Command` creates the `gate` command itself if not already present. If a future `gate`
subcommand is added, register it the same defensive way — don't assume another registrar ran first.

## Canvas GET retries transient failures; agent generate() has a hard timeout

Two hangs the M2 dogfood surfaced. (1) `http.ts` `#dispatch`/`#downloadDispatch` retried only
429/rate-limit; a transient fetch timeout (`AbortSignal.timeout`), network blip, or 5xx aborted the
whole request — fatal across a sweep's ~500+ GETs. They now catch a transient fetch rejection
(`TimeoutError`/`AbortError`/`TypeError`) and retry a 5xx with the existing backoff; 401 and
deterministic 4xx are unchanged. (2) `AISDKAgentRunner` races every `generate()` against a hard
timeout (`generateTimeoutMs`, default 5 min) and aborts the request, so a stalled gateway call
throws `AgentTimeoutError` instead of hanging the run forever (a revise once froze at 0% CPU).

## Ended courses sync via a resolved override, shared by sync and dogfood

`resolveSyncSelection(client, requestedCourse, fallbackId?)` (resolve-sync-selection.ts) returns the
`{courseIds, courseOverrides}` for one requested course: a discoverable course needs no override; an
ended course (enrollment "none", not surfaced by discovery — a past-year pilot) is probed directly
and supplied as an override so `selectCourses` still selects it. An explicitly requested NUMERIC id
is the probe target (the pilot is only the fallback for a non-numeric code) — without this,
`sync --course <other-ended-id>` silently synced the configured pilot instead. Shared by sync-cli,
the dogfood sync flow, and the sweep pre-sync so all three treat ended courses identically.

## Draft loop batches `calculate` and caps steps; `approve` accepts a completed run

The draft prompt once said every derived value MUST be its own `calculate` call, so a model made 41
tiny calls; with each tool step re-sending the growing history the draft hit 1.35M input tokens and
~30 min. Fix: the prompt tells the model to BATCH (one script computes many values, `console.log`
each) and the step cap dropped 40 → 16 (assignment-cli / dogfood-runners / simulate-cli, kept in
sync). Separately, these models emit the draft text and finish WITHOUT parking at the gate, so the
run is "completed", not "pending_approval"; `approveAssignment` now only calls `runner.approve` when
the run is actually parked and otherwise promotes the finished draft to `final/` as-is (M1 replay
never called approve, so this path was unexercised until the dogfood).

## Manifest rebuild skips an unparseable vault doc instead of aborting

`buildCourseManifest` parses every vault doc on every sync; one malformed file (e.g. a hand-authored
guidance note missing frontmatter) threw and failed the whole sync. It now skips an unparseable doc
with a warning and keeps the rest of the course. Corollary: anything writing into a parsed zone
(the dogfood guidance-note flow) must render a valid vault document (`createVaultFrontmatter` +
`renderVaultDocument`), not bare markdown.
