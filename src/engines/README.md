# src/engines

The agent pipeline stages that run after Canvas content lands in the vault:
context retrieval, prep briefs, assignment drafts, as-of-clock simulation,
coverage comparison, the M1 gate bundle, timeline views, and cost reporting.

**Convention**: for a given command, `x.ts` holds the logic and `x-cli.ts` is
a thin `register<Name>Command(program)` wrapper — a Commander adapter that
parses flags, calls into `x.ts`, and wires the command into `src/cli.ts`. The
`x.ts` files have no dependency on Commander; the `x-cli.ts` files hold no
business logic.

Pipeline order: sync (`src/canvas`) → retrieve → prep/draft → simulate →
compare → gate. `timeline` and `cost` are side views, not stages in that
chain.

## Retrieval (context assembly)

- `retrieve.ts` — `assembleCourseContext`: the budget-aware selection/truncation pipeline (priority-file admission with summary fallback, keyword selection, fixed sources, context logging) shared by prep/assignment/simulate.
- `retrieve-files.ts` — manifest parsing and vault text loading (`ManifestEntry`, `readVaultText`) underlying selection.
- `retrieve-triage.ts` — the small triage model call (`TriageFunction`) that generates missing `.summary.md` sidecars on demand.
- `retrieve-modules.ts` — loads a course's Canvas module structure back out of the synced vault and resolves module items to vault-relative paths.
- `retrieve-module-index.ts` — lookup-table helpers (title/canvas_id → path, module membership) that back `retrieve-modules.ts`.
- `retrieve-selection.ts` — turns module structure into the primary candidate path list for a specific assignment or dated period, with keyword-fallback when nothing resolves.

## Prep

- `prep.ts` — `generatePrepBrief`: builds the finished, concepts-synthesized prep brief for a course period.
- `prep-cli.ts` — `register` wrapper exposing `prep <course> [--week W]`.

## Assignment (drafting)

- `assignment.ts` — `draftAssignment`: the complete submittable-draft engine (context assembly, drafting run, provenance header, gate write).
- `assignment-diff.ts` — line-level diff (`lineDiff`) used by `revise` to show what changed between draft versions.
- `assignment-provenance.ts` — zod schema + parse/render for the provenance header every draft carries.
- `assignment-review.ts` — the post-draft self-review pass that appends a `## Correctness check` section, matching draft numbers against the run's logged `calculate` tool calls.
- `assignment-cli.ts` — `register` wrapper exposing `draft`, `revise`, and `approve`.
- `guidance.ts` — parses a course's `guidance/prep-guidance.md` `## Brief structure` declaration into the section list `prep.ts`/`assignment.ts` must produce.

## Simulate (as-of-clock replay)

- `simulate.ts` — `runSimulation`: replays prep+draft as of a past clock reading over a course-week range, writing only to `vault/_simulations/`.
- `simulate-snapshot.ts` — stages an as-of vault snapshot (course content visible up to the simulated date) for a simulation run.
- `simulate-visibility.ts` — the as-of visibility rule (`computeVisibility`) deciding which vault items are "released" at a given simulated date, per the unlock_at → module release → dateless precedence.
- `simulate-output.ts` — normalizes a simulated draft's timestamp so simulation output is deterministic/diffable.
- `simulate-report.ts` — the shared zod schema for a simulation run's `report.json`, used by both `compare.ts` and `gate-m1.ts`.
- `simulate-cli.ts` — `register` wrapper exposing `simulate --pilot [--module] --weeks <start>..<end>`.

## Compare

- `compare.ts` — `compareSimulation`: coverage comparison of a simulation run against the pilot's real past submissions, producing the anchored scorecard.
- `compare-cli.ts` — `register` wrapper exposing `compare <run-id>`.

## Gate (M1 evidence bundle)

- `gate-m1.ts` — packages an existing simulation run's leakage/timeline/grounding checks into the human-verification M1 bundle, then stops.
- `gate-m1-cli.ts` — `register` wrapper exposing `gate m1 --run <run-id>`.

## Timeline

- `timeline.ts` — `buildTimeline`/`renderTimeline`: override-aware due-date aggregation across courses.
- `timeline-ics.ts` — minimal `.ics` calendar parser (`parseIcsEvents`) feeding timeline override detection.
- `timeline-reminders.ts` — due-soon macOS Reminders/notification integration (`writeDueSoonReminders`, `notifyWithOsascript`), invoked from `sync.ts`.
- `timeline-cli.ts` — `register` wrapper exposing `timeline [--weeks N]`.

## Cost

- `cost-cli.ts` — CLI command reporting model spend, reading aggregation logic from `src/models/cost.ts` (not part of this directory).
