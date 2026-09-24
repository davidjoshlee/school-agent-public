# Vault layout

The vault is a local-only Markdown workspace. Navigation follows the way a
student thinks about a course: class → week or milestone → preparation,
materials, and other; assignments keep their prompt, drafts, final submission,
and feedback together.

The layout vocabulary belongs in the path authority in `src/store/paths.ts`.
`_meta/layout.json` records the current version. A v1 vault can be inspected
with a dry run and migrated with:

```sh
school vault migrate
school vault migrate --apply
```

The first command only prints the deterministic plan. `--apply` is an explicit
opt-in; it moves files without replacing an existing destination and updates
`_meta/layout.json` only after every move succeeds. Migration includes
`_index.md`, hidden files, and other unclassified regular files; empty legacy
directories are intentionally left behind. If the destination already contains
identical bytes, migration skips that file and leaves the source copy in place.
After a partial failure, the marker remains v1, but files already moved can make
a retry conflict (including when `_index.md` was not reached). Inspect the plan
and vault state and resolve conflicts manually; automatic safe resume is not
guaranteed.

## Root metadata

`_meta/` stores operational records, not course material. It contains the
layout marker, sync history, capability and authentication metadata, alerts,
and model-context provenance. A per-course `_meta/course-playbook.md` remains
operational course context rather than student-facing material.

## Course tree

Each course lives in a deterministic, APFS-safe `course-<CanvasID>` directory.
The Canvas ID keeps cross-listed courses with the same course code in separate
vault roots; the course code remains visible in course metadata and navigation.

```text
course-17/
├── 00 Home.md
├── Week 01 - Sep 21/
│   ├── 00 Overview.md
│   ├── Prep/
│   ├── Materials/
│   └── Other/
├── Milestone 01 - Goal Setting/
│   ├── 00 Overview.md
│   ├── Prep/
│   ├── Materials/
│   └── Other/
├── Assignments/
│   ├── 2026-10-02 - Synthetic Case Analysis/
│   │   ├── 00 Prompt.md
│   │   ├── Drafts/
│   │   ├── Final/
│   │   └── Feedback.md
├── Resources/
└── Other/
```

`_index.md` remains beside this tree as the machine-readable content manifest;
the sync/navigation writer owns the separate generated `00 Home.md` landing
page.

Only folders with content are created. A course with no published weekly
content does not receive a set of empty week folders. `00 Home.md` should be
the first link a user opens and should link to the next/current week,
upcoming assignments, resources, and any items waiting in `Other`.

`Week` and `Milestone` are the same chronological container with a different
human-facing label. Module titles that identify a milestone use a milestone
container; other modules use week containers. The date in a week name
comes from the strongest available Canvas session date. Modules without a
reliable date are kept in class-level `Other/` so an undated item does not look
like a scheduled class.

## Where content goes

- `Prep/` contains readings, questions, and generated prep associated with a
  particular week or milestone.
- `Materials/` contains slides, cases, extracted file text, and other core
  session material.
- `Other/` is an intentional catch-all. Week-level solutions, recordings, and
  optional follow-ups can live in a week’s `Other/`; undated, ambiguous, or
  course-wide items go in the class-level `Other/`.
- `Resources/` contains class-wide reference material such as the syllabus,
  exam information, and stable reference documents.
- Every assignment has one canonical folder. Drafts and finals are scoped to
  that assignment rather than becoming course-wide lists.

An assignment folder is named `YYYY-MM-DD - Title` when a due date exists and
`Undated - Title` otherwise. Dates sort chronologically; Canvas IDs stay in
frontmatter and are not forced into human-facing names unless a collision
requires a deterministic suffix.

## Document contract

Every generated Markdown document has YAML frontmatter with `canvas_id`,
`canvas_url`, `type`, `dates`, `content_hash`, `source`, `status`, `ai_policy`,
and `redistribution`. `source` is `sync`, `agent`, or `user`; `status` is
`draft`, `approved`, `final`, or `auto-final`. Restricted material is marked
`redistribution: restricted`.

Migration moves the original bytes. It does not rewrite frontmatter, recompute
hashes, or change Canvas IDs.

## Ownership and migration safety

- Synced course content is agent-owned and can be rewritten by a later sync.
- User-owned documents (`source: user`) and pending documents (`status: draft`)
  are never overwritten.
- A migration destination is always created exclusively. If any destination
  already exists, the action is reported as a conflict and the layout marker
  remains v1 so the user can resolve it and resume safely.
- The planner records source and destination paths plus a source digest. The
  executor checks the digest again immediately before moving. Moves use an
  exclusive same-filesystem operation and can be resumed after interruption.
- A dry run makes no directories, moves no files, and never touches the real
  vault. Tests use temporary directories only.
- Ambiguous or undated content is preserved and placed in class-level
  `Other/`; it is not silently discarded.

## Local git history

When `vault.gitInit` is enabled (the default), the writer initializes a Git
repository inside the vault and commits each write with a structured message.
It never configures a remote; the repository is only local undo history.
