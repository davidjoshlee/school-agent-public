---
name: schedule-auto-prep
description: Inspect School Agent class standing and calendar candidates, confirm recurring class meetings, or configure and run automatic class prep. Use for enrolled versus waitlisted or old courses and scheduled prep jobs; not for one-off manual prep.
---

# Schedule class prep

Use the installed `school-agent --help` and `school-agent schedule --help` / `auto-prep --help` for version-specific flags. The [command map](../../references/command-map.md) gives the workflow. This plugin has no Canvas or vault access of its own.

1. Run `school-agent schedule discover` to inspect reported enrollment and calendar candidates. Calendar entries are unconfirmed and must not become a meeting rule without the user's timetable confirmation. An explicit standing designation can resolve a Canvas or registrar mismatch; revisit it when enrollment changes. If enrollment access is denied or standing remains unknown, automatic prep does not run for that course.
2. For a confirmed class, save its recurrence with `schedule add-meeting <canvas-id> --days <mon,wed> --time <HH:mm> --from <YYYY-MM-DD> --until <YYYY-MM-DD>`. Confirm the course ID, weekdays, local time, inclusive date range, and IANA time zone. Check `schedule list` to see upcoming confirmed enrolled meetings; use `--all` to inspect excluded waitlisted, old, and unknown meetings. Use `schedule rules` and `schedule remove-meeting <number>` to remove outdated rules, or `schedule clear-standing <canvas-id>` to remove a manual standing override.
3. Configure the user's desired time zone, lead hours, and late window with `auto-prep configure`; enable it explicitly. Defaults are 24 hours for lead and late catch-up. `auto-prep run` previews due work and verifies current enrollment. Check its course, local week, and existing-prep or ledger outcome before `auto-prep run --execute`.
4. To schedule hourly runs, inspect `auto-prep install`'s dry-run plan and use `auto-prep install --apply` when installing the requested job. Check `auto-prep status`. `auto-prep uninstall` also previews by default; `--apply` removes only the owned job. Installation requires a built CLI launcher on macOS or Linux.

Only an enrolled course with an explicitly confirmed recurring meeting can generate. One automatic attempt is allowed per course and local week. An existing same-week prep is preserved. Started, completed, and failed attempts are recorded in the vault's `_meta/auto-prep-ledger/`; later automatic runs suppress all of them. Inspect failures and their source materials before proposing a deliberate recovery. Scheduled generation uses synced vault materials and sends selected text to the configured model provider. Review the resulting brief's course, week, sources, and answers using [prepare-class](../prepare-class/SKILL.md); course AI-policy metadata does not authorize use.
