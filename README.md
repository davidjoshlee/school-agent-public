# School Agent

School Agent is a local-first command-line tool for reading Canvas course material into a Markdown vault, then helping you prepare for class and draft work for your review. It is designed for a personal, local workflow—not for submitting, posting, or changing anything in Canvas.

## What it does

- Reads allowlisted Canvas courses into a local Markdown vault.
- Creates prep briefs and draft artifacts from material available in that vault.
- Keeps the vault and local index on your computer.
- Tracks estimated model usage and can reconcile eligible calls with AI Gateway’s reported cost.

Canvas access is read-only. School Agent does not write to Canvas, post replies, or submit assignments. AI-policy fields are recorded as metadata and shown in provenance; they are not policy enforcement. You are responsible for following your school’s, instructor’s, and course’s rules.

## Quick start

Supported beta platforms: macOS and Linux with Node.js 22 or 24 and npm. Windows and mobile use are not supported or verified. Install a supported Node.js LTS release from [nodejs.org](https://nodejs.org/en/download); check with `node --version` and `npm --version`.

The next onboarding baseline is planned for `v0.1.1` and has not been published yet. Once it appears on [GitHub Releases](https://github.com/davidjoshlee/school-agent-public/releases), install its `.tgz` asset directly without cloning the repository:

```bash
npm install --global https://github.com/davidjoshlee/school-agent-public/releases/download/v0.1.1/school-agent-0.1.1.tgz
school-agent --help
```

This URL will work only after `v0.1.1` is published; use the exact tag and `.tgz` filename shown on Releases. `v0.1.0` is already released but predates the user-level config discovery described below. To install from source or help develop the project, use the commands below.

```bash
git clone https://github.com/davidjoshlee/school-agent-public.git
cd school-agent-public
npm ci
npm run build
npm link
```

After either installation route, initialize the local config for your institution (replace the example host):

```bash
school-agent setup --canvas-url https://canvas.example.edu
```

`setup` creates `school.config.json` and an adjacent `.env`. The launcher chooses config in this order: explicit `--config <path>` (relative paths use the current directory), existing `school.config.json` in the current directory, then `~/.config/school-agent/school.config.json`. Setup creates the user-level config directory when needed. The selected config’s adjacent `.env` is loaded automatically. Open the newly created `.env` in a text editor and add credentials there; do not put secrets in a command, issue, or chat. Create a Canvas access token using your institution’s instructions and the [official Instructure guide](https://community.instructure.com/en/kb/articles/662901-how-do-i-manage-api-access-tokens-in-my-user-account). Some institutions disable self-service tokens or require approval; ask your Canvas support team if the option is missing. Choose an expiration if available and revoke the token when no longer needed.

For generation, follow the [Vercel AI Gateway API Keys guide](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys) to create a key from the Vercel dashboard, then add it as `AI_GATEWAY_API_KEY`. Vercel account/team access and billing or credits may be required; available credits and pricing can change, so check [current AI Gateway pricing](https://vercel.com/docs/ai-gateway/pricing). Generation is optional for Canvas setup and sync. `school-agent doctor` stays offline; `school-agent doctor --ai` is an opt-in check that makes a small synthetic request for each distinct configured language model, may incur charges, and does not send vault content.

No npm registry publication is used; installs come from GitHub Releases or a source checkout.

`setup` creates a new configuration only when neither `school.config.json` nor its adjacent `.env` already exists. Its conservative defaults are a vault at `~/school-vault`, no vault Git repository, an empty course allowlist, restricted-file handling set to `exclude`, a local index at `~/.local/share/school-agent/index.db`, and a $15 monthly model-spend cap. It will not overwrite existing setup files.

Add your Canvas token and, when you want generation, your AI Gateway key to the `.env` created by setup beside the selected config:

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
```

If you configured an AI Gateway key and want to test provider access, you can also run `school-agent doctor --ai`. This optional check validates the configured model catalogue and sends a small synthetic request for each distinct configured language model. It may incur a small charge and does not use vault content.

`doctor` performs local checks only: it does not contact Canvas or an AI provider. A missing Canvas token is an error; a missing AI Gateway key is a warning, so you can still set up and sync. `auth verify` makes a read-only Canvas request. `onboard --all-active` records all active courses in the allowlist; edit `courses.allowlist` in the selected config to keep just one course for your first sync. Then run the first sync and prep:

```bash
school-agent sync --course <course-id>
school-agent prep <course-id> --week <YYYY-MM-DD>
```

Your first-run acceptance check is concrete: the targeted sync completes, `prep` writes a dated brief under that course’s vault folder, and you open the brief to check that it has a source list/provenance and that those source files are the expected Canvas material. Treat the generated brief as a review aid, not verified work.

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

Maintainers of pinned installations can use the [runtime upgrade and rollback guide](docs/runtime-upgrades.md) and [private parity check](docs/PARITY.md) before switching versions. Run `school-agent vault health` to get a read-only vault/index audit and advisory repair plan.

Coding agents can use the optional [School Agent plugin](docs/PLUGIN.md) for product-specific guidance. It does not connect to Canvas or expose a user's vault.
