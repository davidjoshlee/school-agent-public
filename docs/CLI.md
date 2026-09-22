# School Agent CLI reference

Run commands as `school-agent <command>`. The installed launcher finds `school.config.json` and automatically loads a `.env` beside it; no custom shell function or zsh configuration is required. Add `--help` to any command for its available options.

Examples below use synthetic IDs and URLs.

## First-time setup

```bash
school-agent setup --canvas-url https://canvas.example.edu
school-agent doctor
school-agent auth verify
school-agent courses list --all
school-agent onboard --all-active
school-agent sync
```

`setup` does not overwrite an existing `school.config.json` or adjacent `.env`. `doctor` treats a missing Canvas token as an error and a missing AI Gateway key as a warning, so local setup and sync remain possible before generation is configured.

`onboard --all-active` stores the active-course allowlist. Edit `courses.allowlist` before `sync` if you do not want every discovered active course read into the vault.

## Configuration and authentication

| Command | Purpose |
| --- | --- |
| `school-agent doctor` | Check installation, configuration, and credential readiness. |
| `school-agent auth verify` | Verify the configured Canvas token with a read-only request. |
| `school-agent auth status` | Show available token renewal state. |
| `school-agent config validate` | Validate the configuration. |
| `school-agent config show` | Print effective configuration. |
| `school-agent models map` | Show model mappings. |
| `school-agent models check --catalog <path>` | Check mappings against a recorded model catalog. |

Keep `CANVAS_TOKEN` and `AI_GATEWAY_API_KEY` in the adjacent `.env`, never in a command line or committed file.

## Courses and local content

| Command | Purpose |
| --- | --- |
| `school-agent courses list [--all]` | List discoverable courses; `--all` includes concluded courses. |
| `school-agent onboard --all-active` | Persist active courses as the allowlist. |
| `school-agent sync [--course <id-or-code>] [--full]` | Read allowlisted Canvas material into the vault. |
| `school-agent ingest <file> --course <id>` | Add a local file to a vault course. |
| `school-agent vault migrate` | Check or migrate vault layout where supported. |

For example:

```bash
school-agent sync --course DEMO-101
school-agent sync --course DEMO-101 --full
school-agent ingest ./example-exhibit.pdf --course DEMO-101 --title "Example exhibit"
```

`sync` only reads Canvas. It does not post, submit, or alter any Canvas content. A targeted sync does not rewrite the saved allowlist.

## Preparation and drafts

| Command | Purpose |
| --- | --- |
| `school-agent homework [--days <n>]` | List locally indexed upcoming work. |
| `school-agent timeline [--weeks <n>]` | Show local due-date information. |
| `school-agent prep <course> --week <YYYY-MM-DD>` | Generate a prep brief. |
| `school-agent draft <assignment>` | Generate a draft for review. |
| `school-agent revise <run-id> [feedback]` | Create a new draft version from review feedback. |
| `school-agent approve <run-id>` | Promote an approved local draft to `final/`. |
| `school-agent guidance propose <course>` | Propose, but never overwrite, per-course guidance. |

```bash
school-agent prep DEMO-101 --week 2026-10-05
school-agent draft DEMO-ASSIGNMENT-01
school-agent revise <run-id> "Clarify the second section."
school-agent approve <run-id>
```

Review every output. Source selection, calculation logs, and provenance can help you inspect a result, but they are not correctness or policy-compliance guarantees. AI-policy metadata is informational and does not grant permission to use AI.

## Evaluation and cost

| Command | Purpose |
| --- | --- |
| `school-agent simulate ...` | Run a historical/as-of evaluation where configured. |
| `school-agent compare <run-id>` | Compare an evaluation output. |
| `school-agent gate m1 --run <run-id>` | Write a human-review evaluation bundle. |
| `school-agent cost [--weeks <n>]` | Show recorded estimated and reconciled model usage. |
| `school-agent cost reconcile` | Reconcile eligible entries with AI Gateway-reported cost. |

The configured monthly cap is checked before a model call. It cannot guarantee a hard billing ceiling for an ongoing call; review usage and provider billing yourself.
