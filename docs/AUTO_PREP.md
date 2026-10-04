# Class schedule and automatic prep

This feature is experimental and starts disabled. Synthetic tests cover scheduling and write guards; acceptance with a consenting real user's schedule, paid generation, generated-brief review, and native OS scheduler is still pending. Treat installation as an explicit opt-in to that experimental workflow.

Automatic prep uses a class meeting schedule you confirm. Canvas enrollment helps classify courses as `enrolled`, `waitlisted`, `old`, or `unknown`; Canvas calendar entries appear as unconfirmed candidates. Only an explicitly saved recurring meeting for a currently enrolled course can trigger generation. `unknown`, waitlisted, and old courses are excluded.

## Confirm the schedule

```bash
school-agent schedule discover
school-agent schedule discover --course 12345 --days 30
school-agent schedule set-standing 12345 enrolled
school-agent schedule add-meeting 12345 --days mon,wed --time 09:00 --from 2026-09-21 --until 2026-12-11
school-agent schedule list
school-agent schedule list --all --days 30
school-agent schedule rules
```

`discover` reads Canvas enrollment and calendar events; it does not save meetings. Review the reported standing and calendar candidates against your actual timetable. `set-standing` saves an explicit standing override, which takes precedence over Canvas's reported state when enrollment is available. Use it for a registrar waitlist or another mismatch, and revise it when your status changes. If Canvas enrollment cannot be checked, automatic prep fails closed even when an override says `enrolled`.

`add-meeting` saves a recurring rule in `school.config.json`: weekday names (`sun` through `sat`), local `HH:mm` start time, and inclusive date range. The rule uses the configured IANA time zone. It is a confirmation of a real class meeting, not an import of a Canvas calendar candidate. Review saved rules and avoid overlapping duplicates when your timetable changes.

`schedule list` expands confirmed upcoming meetings and shows only currently enrolled courses by default. `--all` also shows meetings for waitlisted, old, or unknown standing; `--days` sets a 1–90 day look-ahead (14 by default). It checks current Canvas enrollment and labels standing unknown if that check is unavailable.
Use `schedule clear-standing <canvas-id>` to remove an override, or `schedule remove-meeting <number>` with a number from `schedule rules` to delete an outdated recurrence. These commands change only your local configuration.

## Configure and preview

```bash
school-agent auto-prep configure --timezone America/Los_Angeles --lead-hours 24 --window-hours 24 --enable
school-agent auto-prep run
school-agent auto-prep run --json
```

Automatic prep starts disabled. The default lead is 24 hours before the first confirmed meeting of each course's local calendar week; the default late catch-up window is 24 hours. An hourly run that lands inside that window can generate one brief for that course and week. Set your time zone before adding meetings or enabling the job. `auto-prep run` previews due jobs and existing outcomes without generating or writing a ledger. The preview still needs Canvas access to verify current enrollment.

For a one-time run after reviewing the preview:

```bash
school-agent auto-prep run --execute
```

Generation uses material already synced into the vault, so sync the relevant course first. It creates a week-specific prep brief through the normal prep engine. It skips an existing same-week brief instead of replacing it. A local ledger under the vault's `_meta/auto-prep-ledger/` records started, completed, and failed attempts by course and week. Later automatic runs suppress every recorded attempt, including a failed or interrupted one; inspect the ledger and source problem before any deliberate manual recovery. Manual `school-agent prep` has different repeat-run behavior and may replace a changed existing brief.

## Install the hourly job

```bash
school-agent auto-prep install
school-agent auto-prep install --apply
school-agent auto-prep status
school-agent auto-prep uninstall
school-agent auto-prep uninstall --apply
```

`install` and `uninstall` preview their OS changes unless `--apply` is given. Installation requires auto-prep to be enabled and a built, installed `.js` launcher; macOS and Linux are supported. The installed OS job invokes `auto-prep run --execute` hourly. `status` shows configured enablement, confirmed meeting count, and installed/active job state. Uninstall removes only files owned by School Agent; it does not erase meeting rules, generated briefs, or the attempt ledger. To pause generation while retaining the job, run `school-agent auto-prep configure --disable`.

Canvas access remains read-only. Brief generation sends selected local course text to the configured model provider, subject to the same course AI-policy and model-cost considerations as manual prep. Review generated briefs against the readings and class questions before relying on them.
