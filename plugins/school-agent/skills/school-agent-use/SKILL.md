---
name: school-agent-use
description: Help a user install, configure, onboard courses, sync, prepare for class, or review drafts with the School Agent CLI. Use for School Agent operations; not for unrelated Canvas clients.
---

# Operate School Agent

School Agent is a local-first, read-only Canvas companion. Its installed CLI reads an explicit course allowlist into a local Markdown vault and SQLite index, then generates prep briefs and drafts for human review. This skill supplies product expertise, not Canvas access: do not assume the CLI, credentials, or a vault are present.

For current commands and flags, consult the installed CLI's `--help` or the repository's `docs/CLI.md` and `docs/ONBOARDING.md`. For behavior that matters to a user's data, verify the installed version instead of treating this skill as executable authority.

## Common workflow

1. Check `school-agent doctor` and, where appropriate, `school-agent auth verify`. If not installed, use the public repository's README to install from source. Never ask the user to paste tokens into chat or put them on a command line.
2. Discover courses with `school-agent courses list --all`. Confirm the intended courses before changing the allowlist. `school-agent onboard --all-active` selects every active course, so review `courses.allowlist` before syncing.
3. Run `school-agent sync` only for courses the user selected. `sync --course <id-or-code>` narrows a run without changing the saved allowlist.
4. For a requested prep period, use `school-agent prep <course> --week <YYYY-MM-DD>` or `--session <session>` as appropriate. Prefer the explicit requested period over the default current week.
5. Inspect the reported output path. Confirm the file is under the intended course and period, and that it actually addresses each identifiable prep question or flags missing source material. A successful command is not proof of a useful brief. Report gaps and source uncertainty clearly; do not invent answers.
6. For assignments, `draft`, `revise`, and `approve` create local artifacts. Approval is not a Canvas submission. Review the draft and course rules before any final use.

## Boundaries

- Canvas access is read-only; do not invent or imply write, post, reply, or submission capabilities.
- AI-policy metadata is informational, not permission to use AI. The user remains responsible for course rules.
- Selected local text is sent to AI Gateway and its model providers for generation. Restricted files are excluded by default; do not bypass that setting without an informed user decision.
- Keep vault contents, tokens, `.env`, `school.config.json`, and real coursework out of shared repositories, issues, logs, and examples.
- The monthly spend cap is a preflight check, not a guaranteed billing ceiling. Use `school-agent cost` for recorded usage.
