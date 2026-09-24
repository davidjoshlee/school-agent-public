# School Agent

School Agent is a local-first command-line tool for reading Canvas course material into a Markdown vault, then helping you prepare for class and draft work for your review. It is designed for a personal, local workflow—not for submitting, posting, or changing anything in Canvas.

## What it does

- Reads allowlisted Canvas courses into a local Markdown vault.
- Creates prep briefs and draft artifacts from material available in that vault.
- Keeps the vault and local index on your computer.
- Tracks estimated model usage and can reconcile eligible calls with AI Gateway’s reported cost.

Canvas access is read-only. School Agent does not write to Canvas, post replies, or submit assignments. AI-policy fields are recorded as metadata and shown in provenance; they are not policy enforcement. You are responsible for following your school’s, instructor’s, and course’s rules.

## Quick start

Supported: macOS and Linux with Node.js 22 or newer. Windows has not been verified.

```bash
git clone https://github.com/davidjoshlee/school-agent-public.git
cd school-agent-public
npm ci
npm run build
npm link

# Use your own Canvas host, for example https://canvas.example.edu
school-agent setup --canvas-url https://canvas.example.edu
```

Install from source using the commands above; an npm registry release is not yet available.

`setup` creates a new configuration only when neither `school.config.json` nor its adjacent `.env` already exists. Its conservative defaults are a vault at `~/school-vault`, no vault Git repository, an empty course allowlist, restricted-file handling set to `exclude`, a local index at `~/.local/share/school-agent/index.db`, and a $15 monthly model-spend cap. It will not overwrite existing setup files.

Add your Canvas token and AI Gateway key to a `.env` file beside `school.config.json`:

```dotenv
CANVAS_TOKEN=replace_with_your_token
AI_GATEWAY_API_KEY=replace_with_your_gateway_key
```

The launcher automatically loads that adjacent `.env`; no shell function or custom zsh setup is needed. Then confirm access and select the courses you want the tool to read:

```bash
school-agent doctor
school-agent auth verify
school-agent courses list --all
school-agent onboard --all-active
school-agent sync
school-agent prep <course-id> --week <YYYY-MM-DD>
```

`doctor` reports a missing Canvas token as an error. A missing AI Gateway key is a warning, so you can still set up and sync. `onboard --all-active` persists the active-course allowlist. Review `courses.allowlist` in `school.config.json` and remove any course you do not want synced before running `sync`.

For the fuller walkthrough, including key creation and troubleshooting, see [Onboarding](docs/ONBOARDING.md).

## Privacy, course material, and cost

Your vault and index are stored locally. When you ask School Agent to generate a brief or draft, selected text from your local course material is transmitted to AI Gateway and its model providers to perform that request. Restricted files are excluded by default; verify your course rules and configuration before changing that setting.

The monthly cap is checked before a model call, but it cannot guarantee a billing ceiling for an ongoing call. Costs begin as local estimates based on measured usage; `cost reconcile` can replace eligible estimates with AI Gateway’s reported amounts. Review usage regularly.

Never commit or share `.env`, `school.config.json`, vault contents, access tokens, or course work.

## Development

```bash
npm run typecheck
npm run lint
npm test
```

Contributions are welcome—please read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). The code is under the [MIT License](LICENSE); it does not grant rights to course materials or other user content.

Coding agents can use the optional [School Agent plugin](docs/PLUGIN.md) for product-specific guidance. It does not connect to Canvas or expose a user's vault.
