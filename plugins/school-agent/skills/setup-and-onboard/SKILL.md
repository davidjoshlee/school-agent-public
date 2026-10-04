---
name: setup-and-onboard
description: Install and initialize School Agent, verify local credentials, choose Canvas courses, and prepare the allowlist. Use for first setup or adding courses; not for routine sync or class prep.
---

# Set up and onboard School Agent

Use the [School Agent product map](../../school-agent.md) when broader product context is needed. Check the public [onboarding guide](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/ONBOARDING.md), [CLI reference](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/CLI.md), or the installed CLI's `--help` before giving commands; repository docs are not bundled with this plugin, and flags can change.

## Workflow

1. Check prerequisites in onboarding docs (the local CLI beta supports macOS/Linux and Node.js 22 or 24). Follow the documented installation steps, then run `school-agent setup --canvas-url https://<institution-canvas-host>`. Configuration resolves in this order: explicit `--config`, existing `school.config.json` in the current directory, then `~/.config/school-agent/school.config.json`. Setup creates the selected config and adjacent `.env` only when neither exists; if either exists, inspect and preserve it instead of rerunning setup.
2. Put `CANVAS_TOKEN` in the adjacent `.env`; `AI_GATEWAY_API_KEY` is optional until generation is needed. Do not ask for secrets in chat, put them in command arguments, or print their values. Keep configuration, `.env`, vault, and index private.
3. Run `school-agent doctor` and `school-agent auth verify`. Doctor checks local prerequisites/configuration/credential presence without Canvas access; auth verify makes a read-only Canvas check. Diagnose reported failures from the configured Canvas URL, token variable name, `.env` location, and filesystem writability.
4. Run `school-agent courses list --all` and confirm which courses belong in scope. `school-agent onboard --all-active` writes every discovered active course ID to `courses.allowlist`; this is not interactive course selection. Inspect the selected config file (the explicit path, existing current-directory config, or `~/.config/school-agent/school.config.json`) and remove unwanted IDs before syncing. A targeted sync is available later without changing the saved allowlist.
5. Sync only after reviewing the allowlist. For later runs, route to [sync-and-diagnose](../sync-and-diagnose/SKILL.md). In a fresh source checkout, read root `AGENTS.md`, run `npm ci` and `npm run build`, and use `node bin/school.js` to avoid invoking an older global CLI. Rebuild after pulling.
6. Optional reading access comes after local setup: check installed `vault --help` and the public [access guide](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/OBSIDIAN.md). Obsidian guide preparation is local and does not enable sync. Applying a reading-copy destination may upload coursework; confirm the account/folder and rules first. An applied `--current` mapping opts into one-way refresh after successful writing commands. No reverse sync, phone CLI, or automatic OS job setup. These features are newer than release `v0.1.1`; use current source until a release contains them.

## First-user beta acceptance

For an explicitly requested first-user check, keep the scope to one local macOS/Linux CLI user, their own credentials, one confirmed course, a targeted sync, and one dated prep brief. The user must inspect the brief's provenance against expected Canvas material and judge its accuracy; command success alone is not acceptance. See [the beta acceptance checklist](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/FIRST-USER-BETA.md) for the record fields and release boundary. Synthetic tests and package smoke do not stand in for a real first-user run, and a friend check remains pending until that friend completes it and reports the result.

## Guardrails

- `onboard --all-active` records an allowlist; it does not mean the user selected every active course. Make scope visible before sync.
- Canvas operations are read-only. Onboarding does not enable posting, submissions, or replies.
- Beta CLI scope is local macOS/Linux. Optional iPhone reading uses an exported copy and the user's Google Drive client, not mobile CLI execution or live two-way vault sync. The optional plugin is independent of the CLI release.
- Generation is optional for setup and sync. AI-policy metadata is informational and does not grant course permission. Selected local text may be sent to AI Gateway and its model provider during generation; follow applicable course rules.
- `doctor --ai` is an optional bounded synthetic provider check that may incur charges. Do not run it by default or treat it as required for Canvas sync acceptance.
- Use only synthetic examples when sharing commands or documenting behavior. Never include real tokens, `.env` contents, vault text, or coursework in repository artifacts.
