# School Agent: start here

This is the public, sanitized source repository for a local-first Canvas CLI.
Read [CLAUDE.md](CLAUDE.md) for implementation rules and [Onboarding](docs/ONBOARDING.md)
for setup. Never assume another computer has the maintainer's credentials,
courses, vault, configuration, or installed runtime.

## Fresh clone

The CLI supports macOS/Linux with Node.js 22 or 24 and npm. Windows is unverified;
an iPhone can read exported files but cannot run this CLI.

```bash
npm ci
npm run build
node bin/school.js --version
node bin/school.js --help
```

Use `node bin/school.js` from this checkout to run its exact build. `npm link` is
optional for installing the `school-agent` / `school` aliases; verify the alias's
version first. After pulling, rerun `npm ci` and `npm run build`: pulling alone
does not update `dist/` or a separate release installation.

## Onboard a new user

1. Ask for their institution's Canvas base URL and desired courses, not tokens.
   Run `node bin/school.js setup --canvas-url https://canvas.example.edu` with
   their host. Setup refuses existing config or adjacent `.env`; preserve them.
2. Config precedence: explicit `--config`, existing current-directory
   `school.config.json`, then `~/.config/school-agent/school.config.json`.
   The user privately edits the selected config's adjacent `.env`.
   `CANVAS_TOKEN` enables Canvas reads; `AI_GATEWAY_API_KEY` is optional for sync.
   Never print secrets, request them in chat, or put them in command arguments.
3. Run `doctor` (offline), then user-authorized `auth verify` and
   `courses list --all` (Canvas GETs). `onboard --all-active` saves **all** active
   IDs, not an interactive selection. Review the saved allowlist with the user
   before syncing; start with one confirmed course.
4. Run `sync --course <id>`. Only when generation is wanted and permitted, run
   `prep <id> --week <YYYY-MM-DD>` with an explicit target. `doctor --ai` is an
   optional synthetic provider check that may cost money, outside the local ledger.
5. Open the brief. Verify course/period, sources, provenance, links and actual
   answers. Successful execution alone is not first-user acceptance. Use
   [the beta checklist](docs/FIRST-USER-BETA.md) to record the user's review.

Commands above after setup are subcommands of `node bin/school.js` (or a verified
`school-agent` installation). Check `<command> --help` before giving flags.
Never invent credentials, a schedule, or a completed acceptance run.

## Daily use

- Refresh: `sync --course <id-or-code>`; inspect local work with `homework` and
  `timeline`. See [the CLI reference](docs/CLI.md).
- Prepare: `prep <course> --week <YYYY-MM-DD>` or `--session <value>` (not both).
  Verify the output is in the matching Week/Milestone `Prep/` folder.
- Draft/review: `draft <assignment>`, `revise <run-id> "feedback"`, then
  `approve <run-id>` only with the user's approval. Approval is local, not Canvas
  submission. AI-policy metadata is neither permission nor enforcement.
- Inspect: `vault health`, `vault reconcile-index`, `cost`, and provenance records.
  Review migration dry runs and exact paths before applying any repairs.
- Obsidian: `vault obsidian` previews the existing folder; `--apply` creates a
  guide without moving originals or configuring sync.
- Google Drive/iPhone reading: `vault reading-copy --destination <folder>` previews;
  `--apply` exports a snapshot. `--current --apply` explicitly opts into a
  persistent one-way copy refreshed after successful writing commands.
  Confirm the cloud account/folder and course rules before applying: a Drive-backed
  destination uploads coursework. No reverse sync or remote CLI is provided.
  See [the access guide](docs/OBSIDIAN.md).

Keep one primary writer computer. The local vault/index/run state are authoritative;
an exported copy is not another working vault. Finder/Obsidian edits need a manual
reading-copy refresh. Drive for desktop controls cloud upload timing.

## Safety and development

Canvas is GET-only: never post, submit, reply, or modify course data. Generation
sends selected text to AI Gateway/providers and may cost money. Restricted files
default to exclusion; neither source selection nor policy metadata proves compliance
or correctness. The spend cap is a preflight, not an absolute billing ceiling.

Never commit `.env`, user config, actual coursework, account IDs, vault output or
databases. Do not point tests at a live vault or credentials. Paths come from
`src/store/paths.ts`; writers must preserve user guidance and pending drafts.

```bash
npm run typecheck
npm run lint
npm test
npm run package:smoke
```

Tests use synthetic data and no live Canvas/model requests. Package smoke installs
the packed CLI in an isolated home and may fetch npm dependencies. Do not install
OS jobs or enable unattended generation as part of onboarding. Optional agent skills
are in [the plugin](docs/PLUGIN.md); this file and the docs work without that plugin.
