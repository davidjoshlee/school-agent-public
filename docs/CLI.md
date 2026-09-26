# School Agent CLI reference

Run commands as `school-agent <command>`. The launcher chooses an explicit `--config <path>`, then an existing current-directory `school.config.json`, then `~/.config/school-agent/school.config.json`; it loads the adjacent `.env`. No custom shell function or zsh configuration is required. Add `--help` to any command for its available options.

Examples below use synthetic IDs and URLs.

## First-time setup

```bash
school-agent setup --canvas-url https://canvas.example.edu
school-agent doctor
school-agent auth verify
school-agent courses list --all
school-agent onboard --all-active
```

`setup` does not overwrite an existing config or adjacent `.env`. The launcher selects config in this order: explicit `--config <path>` (relative paths resolve from the current directory), an existing current-directory `school.config.json`, then `~/.config/school-agent/school.config.json`. Setup creates the parent directory for the user-level fallback. The selected config’s adjacent `.env` is loaded automatically; edit the file setup created to add credentials.

`doctor` is an offline local check. A missing Canvas token is an error and a missing AI Gateway key is a warning, so setup and sync can proceed without AI credentials. `doctor --ai` is a separate opt-in probe: it validates the configured model catalogue and sends one small synthetic generation request for each distinct configured language model. The requests may incur small charges and do not include vault content. Get Canvas token instructions from your institution and [Instructure](https://community.instructure.com/en/kb/articles/662901-how-do-i-manage-api-access-tokens-in-my-user-account). To enable generation, follow the [Vercel AI Gateway API Keys guide](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys) to create a key from the Vercel dashboard; account/team access and credits or billing may be required. Review [current pricing](https://vercel.com/docs/ai-gateway/pricing).

To try the AI probe during setup, run `school-agent doctor --ai` after adding `AI_GATEWAY_API_KEY`; this step is optional and may incur a charge.

`auth verify` checks Canvas with a read-only request. `onboard --all-active` stores every active course ID in the allowlist. Review `courses.allowlist` in the selected config and leave only one course for a first sync; then target that course explicitly. For first-time setup and the acceptance check, see [Onboarding](ONBOARDING.md).

## Configuration and authentication

| Command | Purpose |
| --- | --- |
| `school-agent doctor` | Check installation, configuration, and credential readiness. |
| `school-agent doctor --ai` | Opt into model catalogue validation and synthetic Gateway probes for each distinct configured language model; may incur charges and uses no vault text. |
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
| `school-agent vault health [--json]` | Audit vault and SQLite index consistency without making changes. Returns a nonzero status when issues are found. |
| `school-agent vault reconcile-index [--json]` | Classify missing indexed paths and show unique local relink candidates; read-only. |
| `school-agent vault migrate` | Check or migrate vault layout where supported. |

For example:

```bash
school-agent sync --course DEMO-101
school-agent prep DEMO-101 --week 2026-10-05
school-agent sync --course DEMO-101 --full
school-agent ingest ./example-exhibit.pdf --course DEMO-101 --title "Example exhibit"
school-agent vault health
school-agent vault health --json
school-agent vault reconcile-index
```

For a first run, confirm the targeted sync completes, then open the dated prep brief under that course’s vault folder. Review its source list/provenance and confirm the listed files match the Canvas material you expected.

`vault health` reports duplicate numbered Week directories, missing or out-of-root indexed paths, missing indexed files, and manifest-bearing course roots absent from the index. Its repair suggestions are advisory and are never applied by this command. `--json` prints the full audit and repair plan as JSON.

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

## Class schedule and automatic prep

| Command | Purpose |
| --- | --- |
| `school-agent schedule discover [--course <canvas-id>] [--days <n>] [--json]` | Read Canvas enrollment and show unconfirmed calendar candidates. |
| `school-agent schedule list [--days <n>] [--all]` | Show confirmed upcoming meetings; enrolled only by default. |
| `school-agent schedule set-standing <canvas-id> <enrolled\|waitlisted\|old>` | Save an explicit course-standing override. |
| `school-agent schedule clear-standing <canvas-id>` | Return to Canvas standing evidence. |
| `school-agent schedule add-meeting <canvas-id> --days <mon,wed> --time <HH:mm> --from <YYYY-MM-DD> --until <YYYY-MM-DD>` | Confirm a recurring class meeting. |
| `school-agent schedule rules` / `schedule remove-meeting <number>` | Review or remove a confirmed recurrence. |
| `school-agent auto-prep configure [--enable\|--disable] [--timezone <iana-zone>] [--lead-hours <n>] [--window-hours <n>]` | Set the opt-in prep policy. |
| `school-agent auto-prep run [--json]` | Preview due prep without generating it. |
| `school-agent auto-prep run --execute` | Generate due briefs and record attempts locally. |
| `school-agent auto-prep install [--apply]` | Preview or install the hourly OS job. |
| `school-agent auto-prep uninstall [--apply]` | Preview or remove the owned OS job. |
| `school-agent auto-prep status` | Show policy and OS job status. |

Only confirmed recurring meetings for courses currently classified as enrolled can trigger automatic prep. Calendar entries are suggestions to review, not a schedule source. The default lead and late catch-up windows are both 24 hours; the job checks hourly. A course gets at most one automatic prep attempt per local week. It never replaces an existing weekly brief, and failed or interrupted attempts remain suppressed in the local ledger until deliberately reviewed. See [Class schedule and automatic prep](AUTO_PREP.md) for setup and recovery details.

## Evaluation and cost

| Command | Purpose |
| --- | --- |
| `school-agent simulate ...` | Run a historical/as-of evaluation where configured. |
| `school-agent compare <run-id>` | Compare an evaluation output. |
| `school-agent gate m1 --run <run-id>` | Write a human-review evaluation bundle. |
| `school-agent cost [--weeks <n>]` | Show recorded estimated and reconciled model usage. |
| `school-agent cost reconcile` | Reconcile eligible entries with AI Gateway-reported cost. |

The configured monthly cap is checked before a model call. It cannot guarantee a hard billing ceiling for an ongoing call; review usage and provider billing yourself.
