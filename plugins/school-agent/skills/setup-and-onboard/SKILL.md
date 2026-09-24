---
name: setup-and-onboard
description: Install and initialize School Agent, verify local credentials, choose Canvas courses, and prepare the allowlist. Use for first setup or adding courses; not for routine sync or class prep.
---

# Set up and onboard School Agent

Use the [School Agent product map](../../school-agent.md) when broader product context is needed. Check the public [onboarding guide](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/ONBOARDING.md), [CLI reference](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/CLI.md), or the installed CLI's `--help` before giving commands; repository docs are not bundled with this plugin, and flags can change.

## Workflow

1. Check prerequisites in onboarding docs (currently macOS/Linux and Node.js 22+). Follow the documented source installation and build steps, then run `school-agent setup --canvas-url https://<institution-canvas-host>` from the intended configuration location. Setup creates `school.config.json` and `.env` only when neither exists; if either exists, inspect and preserve it instead of rerunning setup.
2. Put `CANVAS_TOKEN` in the adjacent `.env`; `AI_GATEWAY_API_KEY` is optional until generation is needed. Do not ask for secrets in chat, put them in command arguments, or print their values. Keep configuration, `.env`, vault, and index private.
3. Run `school-agent doctor` and `school-agent auth verify`. Doctor checks local prerequisites/configuration/credential presence without Canvas access; auth verify makes a read-only Canvas check. Diagnose reported failures from the configured Canvas URL, token variable name, `.env` location, and filesystem writability.
4. Run `school-agent courses list --all` and confirm which courses belong in scope. `school-agent onboard --all-active` writes every discovered active course ID to `courses.allowlist`; this is not interactive course selection. Inspect and remove unwanted IDs in `school.config.json` before syncing. A targeted sync is available later without changing the saved allowlist.
5. Sync only after reviewing the allowlist. For later runs, route to [sync-and-diagnose](../sync-and-diagnose/SKILL.md).

## Guardrails

- `onboard --all-active` records an allowlist; it does not mean the user selected every active course. Make scope visible before sync.
- Canvas operations are read-only. Onboarding does not enable posting, submissions, or replies.
- Generation is optional for setup and sync. AI-policy metadata is informational and does not grant course permission. Selected local text may be sent to AI Gateway and its model provider during generation; follow applicable course rules.
- Use only synthetic examples when sharing commands or documenting behavior. Never include real tokens, `.env` contents, vault text, or coursework in repository artifacts.
