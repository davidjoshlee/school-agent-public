# Onboarding

This guide sets up a personal local installation. It uses synthetic examples; replace `https://canvas.example.edu` with your institution’s Canvas URL.

## Requirements

- macOS or Linux (local CLI beta; Windows and mobile are not supported or verified)
- Node.js 22 or 24 with npm
- A Canvas access token (an AI Gateway API key is needed only for generation)

Install Node.js from [nodejs.org](https://nodejs.org/en/download), then confirm it is available with `node --version` and `npm --version`. You do not need a custom shell function or zsh configuration.

## Install and initialize

The next onboarding baseline is planned for `v0.1.1` and has not been published yet. Once it appears on [GitHub Releases](https://github.com/davidjoshlee/school-agent-public/releases), install its `.tgz` asset directly without cloning the repository:

```bash
npm install --global https://github.com/davidjoshlee/school-agent-public/releases/download/v0.1.1/school-agent-0.1.1.tgz
school-agent --help
```

The example URL works only after `v0.1.1` is published; use the exact tag and `.tgz` asset URL shown on Releases. `v0.1.0` is available but predates the user-level config discovery in this guide. To contribute or run from source, use this path instead:

```bash
git clone https://github.com/davidjoshlee/school-agent-public.git
cd school-agent-public
npm ci
npm run build
npm link
```

After either installation route, initialize your config for your institution (replace the example host):

```bash
school-agent setup --canvas-url https://canvas.example.edu
```

Setup does not replace an existing `school.config.json` or adjacent `.env`. A new setup uses:

```json
{
  "canvas": { "baseUrl": "https://canvas.example.edu" },
  "vault": { "path": "~/school-vault", "gitInit": false },
  "index": { "path": "~/.local/share/school-agent/index.db" },
  "courses": { "mode": "list", "allowlist": [] },
  "cost": { "maxMonthlySpendUSD": 15 },
  "restrictedFileHandling": "exclude"
}
```

The launcher chooses configuration in this order: an explicit `--config <path>` (relative paths are resolved from the current directory), an existing `school.config.json` in the current directory, then `~/.config/school-agent/school.config.json`. When using the user-level fallback, `setup` creates the needed parent directory. The `.env` belongs beside the selected config file.

## Add credentials

Open the `.env` that `setup` created beside the selected config file in a text editor. Add your Canvas token there, and keep the file private:

```dotenv
CANVAS_TOKEN=replace_with_your_token
AI_GATEWAY_API_KEY=replace_with_your_gateway_key
```

The installed launcher loads this file automatically. Create a Canvas access token by following your institution’s instructions and [Instructure’s user-account guide](https://community.instructure.com/en/kb/articles/662901-how-do-i-manage-api-access-tokens-in-my-user-account). Some schools disable self-service token creation or require staff approval; contact your institution’s Canvas support channel if you cannot create one. Choose an expiration where offered and revoke the token when you no longer need it. Never paste a token into chat, an issue, a command, or a screenshot.

For AI-powered generation only, open the [Vercel AI Gateway API Keys guide](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys), then create a key from the Vercel dashboard’s AI Gateway API Keys page and add it as `AI_GATEWAY_API_KEY`. You need Vercel account/team access; billing or credits may apply. Credit availability and prices can change, so review [current AI Gateway pricing](https://vercel.com/docs/ai-gateway/pricing). You can finish setup and sync without this key. The ordinary `doctor` command is offline. If you set the key, `doctor --ai` validates the model catalogue and sends one small synthetic request for each distinct configured language model. It may incur a small charge and does not include vault content.

If `setup` says a setup file already exists, it left both files untouched. Back up and review your existing `school.config.json` and `.env`, then continue with those files; do not rerun setup expecting it to merge settings. If setup fails on the Canvas URL, provide the institution's HTTPS Canvas base URL only (no username, password, query, or fragment).

## Verify, choose, and sync

```bash
school-agent doctor
school-agent auth verify
school-agent courses list --all
school-agent onboard --all-active
```

Optionally, after adding `AI_GATEWAY_API_KEY`, run `school-agent doctor --ai` to confirm model connectivity. This opt-in check sends synthetic text only and may be billed; you can skip it for a Canvas-only workflow. Probe costs are not recorded in the local usage ledger or governed by its monthly cap, so review your Gateway-side budget first. A global `--model <id>` override checks that model instead of the configured defaults.

`doctor` is a local diagnostic and does not contact Canvas or an AI provider. It treats a missing Canvas token as an error and a missing AI Gateway key as a warning. `auth verify` checks Canvas with a read-only request. `onboard --all-active` saves every active course ID to `courses.allowlist`; before syncing, edit that list in the selected config to keep only one course for the first run. Then use that course ID for a targeted sync and dated prep:

```bash
school-agent sync --course <course-id>
school-agent prep <course-id> --week <YYYY-MM-DD>
```

For the first-run acceptance check, confirm the targeted sync finishes; then find the dated prep brief in the course’s vault folder and open it. Review its source list/provenance and verify the cited files are the material you expected from Canvas. `sync` only reads Canvas. It never posts, submits work, or modifies course data.

## Privacy and responsible use

The vault and index stay on your computer. Generation requests may send selected vault text to AI Gateway and the model provider used for that request. Restricted files are excluded by default, but you remain responsible for your course rules, privacy obligations, and any changes you make to configuration.

AI-policy values are informational metadata, not an enforcement mechanism. School Agent does not grant permission to use AI in any course; follow the policy that applies to you.

The $15 cap is a preflight check before a call. It cannot guarantee that an in-progress call will not carry usage beyond the cap. Local estimates are based on recorded token usage; reconcile costs when available and review `school-agent cost` regularly.

If `doctor` reports an invalid configuration, run `school-agent config validate` and fix the named field in the selected config. A missing Canvas token means `CANVAS_TOKEN` is blank or absent in the `.env` beside that config; a missing AI key is expected for sync-only use but blocks generation. If `auth verify` fails, check the Canvas base URL, token expiration and permissions, network access, and that the token variable name matches `canvas.tokenEnv` in the config. Never paste credentials, real course material, or private Canvas URLs into an issue.
