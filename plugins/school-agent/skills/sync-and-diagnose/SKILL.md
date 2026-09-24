---
name: sync-and-diagnose
description: Sync selected Canvas courses into the local School Agent vault and diagnose missing, stale, or apparently duplicated synced content. Use for routine sync and sync troubleshooting; not for initial installation or prep generation.
---

# Sync and diagnose School Agent

Use the [School Agent product map](../../school-agent.md) for broader context. Check the public [CLI reference](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/CLI.md) and [vault-layout guide](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/vault-layout.md), and, when behavior is ambiguous, the installed CLI help and corresponding repository code if a checkout exists. These repo docs are not bundled with the plugin. Do not infer repair commands from symptoms.

## Sync

1. Run `school-agent doctor` and `school-agent auth verify` when authentication or local setup may be involved. Never request or expose token values.
2. Inspect `courses.allowlist` in the active `school.config.json`. Run `school-agent sync` only when that saved scope is intended, or use `school-agent sync --course <id-or-code>` to target one discovered course. Targeted sync does not change the allowlist. `--full` redownloads current file metadata rather than using the incremental cache; use it only when that is relevant to the diagnosis.
3. Read the per-course status, change count, and gaps in command output. A failed course or a gap needs diagnosis; successful sync does not certify that every Canvas resource was available.
4. Verify the result in the configured vault using the linked public vault-layout guide: course directories are based on normalized course codes; synced modules, assignments, announcements, files, and the course manifest are under that course. Compare course identity and Canvas IDs in document frontmatter when names or folders appear ambiguous.

## Diagnose duplicate weeks or course mix-ups

The v2 vault groups synced course material under `Week NN - Mon DD/` or `Milestone NN - Title/` folders. Prep is stored in that period's `Prep/` directory when retrieval selected a matching module; otherwise it may appear in course-level `Other/Prep/`. For duplicate-week reports, compare course-code root, Canvas course ID, period number/date, and frontmatter before treating paths as duplicates. Same week labels in different course roots are expected.

When two classes seem to contain the same week, first establish whether this is a duplicate course directory, duplicate module content, or a prep period mix-up:

1. Check the active config's vault path and allowlist, then compare Canvas course IDs and course codes in `school-agent courses list --all`, the local course directories, manifests, and relevant document frontmatter.
2. Check `src/store/paths.ts` for course-path derivation and `src/canvas/sync.ts` / `src/canvas/sync-course.ts` for selection and writes. Current course directories are derived from a normalized course code (`courseId` is not added as a disambiguator). Distinct codes that normalize to the same slug can therefore resolve to the same path; verify actual IDs and path values before calling it a collision.
3. For prep, inspect the output path printed by `school-agent prep`, its course directory, title/period in frontmatter, and content. A prep run's course comes from the local index; use the intended course ID or code and explicit `--week <YYYY-MM-DD>` to avoid the default `current` period.
4. Report the concrete evidence and the narrowest safe next step. The supported sync interface includes `sync`, `sync --course`, and `sync --full`; do not claim there is a duplicate-week cleanup, course-path repair, or re-key command unless current CLI help and implementation establish it. Preserve user-edited files and make a backup before any manual filesystem repair.

## Boundaries

- Sync reads Canvas and writes local vault/index state. It does not post or submit to Canvas.
- Do not broaden the allowlist as a troubleshooting shortcut.
- Keep `.env`, `school.config.json`, vault content, and real coursework out of logs and shared artifacts.
