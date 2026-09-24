# Command map

Use `school-agent <command> --help` for the installed version's flags. This map summarizes workflows; the [public CLI reference](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/CLI.md) is maintained with the repository.

| Need | Command |
| --- | --- |
| Inspect setup | `doctor`, `config validate`, `config show` |
| Inspect course scope | `courses list [--all]`, `onboard --all-active` |
| Read Canvas into the vault | `sync [--course <id-or-code>] [--full]` |
| Prepare | `homework`, `timeline`, `prep <course> --week <YYYY-MM-DD>` |
| Draft workflow | `draft <assignment>`, `revise <run-id> [feedback]`, `approve <run-id>` |
| Inspect model routing | `models map`, `models check --catalog <path>` |
| Inspect/reconcile usage | `cost [--weeks <n>]`, `cost reconcile [--weeks <n>]` |

`draft <assignment> --discuss <message>` is discussion only and does not create a draft version. A draft command reports the run ID and local artifact path; keep the run ID for revision or approval. Approval promotes a local artifact and never performs Canvas submission.
