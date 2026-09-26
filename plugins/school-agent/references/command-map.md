# Command map

Use `school-agent <command> --help` for the installed version's flags. This map summarizes workflows; the [public CLI reference](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/CLI.md) is maintained with the repository.

| Need | Command |
| --- | --- |
| Inspect setup | `doctor`, `config validate`, `config show` |
| Inspect course scope | `courses list [--all]`, `onboard --all-active` |
| Read Canvas into the vault | `sync [--course <id-or-code>] [--full]` |
| Inspect vault/index health | `vault health [--json]`, `vault reconcile-index [--json]` |
| Prepare | `homework`, `timeline`, `prep <course> --week <YYYY-MM-DD>` |
| Discover class standing and calendar candidates | `schedule discover [--course <canvas-id>] [--days <n>] [--json]` |
| List confirmed upcoming meetings | `schedule list [--days <n>] [--all]` (enrolled only by default) |
| Confirm standing and meetings | `schedule set-standing <canvas-id> <enrolled\|waitlisted\|old>`, `schedule add-meeting <canvas-id> --days <mon,wed> --time <HH:mm> --from <YYYY-MM-DD> --until <YYYY-MM-DD>` |
| Correct saved schedule | `schedule clear-standing <canvas-id>`, `schedule rules`, `schedule remove-meeting <number>` |
| Configure scheduled prep | `auto-prep configure [--enable\|--disable] [--timezone <iana-zone>] [--lead-hours <n>] [--window-hours <n>]` |
| Preview or generate due prep | `auto-prep run [--json]`, `auto-prep run --execute` |
| Manage the hourly job | `auto-prep install [--apply]`, `auto-prep uninstall [--apply]`, `auto-prep status` |
| Draft workflow | `draft <assignment>`, `revise <run-id> [feedback]`, `approve <run-id>` |
| Inspect model routing | `models map`, `models check --catalog <path>` |
| Inspect/reconcile usage | `cost [--weeks <n>]`, `cost reconcile [--weeks <n>]` |

`draft <assignment> --discuss <message>` is discussion only and does not create a draft version. A draft command reports the run ID and local artifact path; keep the run ID for revision or approval. Approval promotes a local artifact and never performs Canvas submission.

Calendar events are unconfirmed candidates. Only saved recurring meetings for currently enrolled courses can trigger automatic prep. `auto-prep run` is a preview; `--execute` creates due briefs. Install and uninstall are dry-runs until `--apply`. See the [auto-prep guide](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/AUTO_PREP.md) for the local ledger and suppression behavior.
