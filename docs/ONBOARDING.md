# Onboarding

This guide sets up a personal local installation. It uses synthetic examples; replace `https://canvas.example.edu` with your institution’s Canvas URL.

## Requirements

- macOS or Linux
- Node.js 22 or newer
- A Canvas access token (an AI Gateway API key is needed only for generation)

Windows has not been verified. You do not need a custom shell function, zsh configuration, or a cloud account for vault storage.

## Install and initialize

After a tagged release is available, open [GitHub Releases](https://github.com/davidjoshlee/school-agent-public/releases), copy its `.tgz` asset URL, then run:

```bash
npm install --global https://github.com/davidjoshlee/school-agent-public/releases/download/v0.1.0/school-agent-0.1.0.tgz
school-agent --help
```

The `v0.1.0` example will work after that release is published. Use the exact tag and `.tgz` filename listed for the version you choose. If there is no release yet, or if you want to run from source, use this path:

```bash
git clone https://github.com/davidjoshlee/school-agent-public.git
cd school-agent-public
npm ci
npm run build
npm link
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

## Add credentials

Create `.env` beside `school.config.json` and keep it private:

```dotenv
CANVAS_TOKEN=replace_with_your_token
AI_GATEWAY_API_KEY=replace_with_your_gateway_key
```

The installed launcher loads this file automatically. Canvas tokens are typically created from Canvas account settings; follow your institution’s instructions and choose an appropriate expiration.

If `setup` says a setup file already exists, it left both files untouched. Back up and review your existing `school.config.json` and `.env`, then continue with those files; do not rerun setup expecting it to merge settings. If setup fails on the Canvas URL, provide the institution's HTTPS Canvas base URL only (no username, password, query, or fragment).

## Verify, choose, and sync

```bash
school-agent doctor
school-agent auth verify
school-agent courses list --all
school-agent onboard --all-active
```

`doctor` treats a missing Canvas token as an error and a missing AI Gateway key as a warning, which lets you set up and sync before using generation. The last command saves active courses to `courses.allowlist`. Open `school.config.json`, remove anything you do not want included, and then sync:

```bash
school-agent sync
school-agent prep <course-id> --week <YYYY-MM-DD>
```

`sync` only reads Canvas. It never posts, submits work, or modifies course data.

## Privacy and responsible use

The vault and index stay on your computer. Generation requests may send selected vault text to AI Gateway and the model provider used for that request. Restricted files are excluded by default, but you remain responsible for your course rules, privacy obligations, and any changes you make to configuration.

AI-policy values are informational metadata, not an enforcement mechanism. School Agent does not grant permission to use AI in any course; follow the policy that applies to you.

The $15 cap is a preflight check before a call. It cannot guarantee that an in-progress call will not carry usage beyond the cap. Local estimates are based on recorded token usage; reconcile costs when available and review `school-agent cost` regularly.

If `doctor` reports an invalid configuration, run `school-agent config validate` and fix the named field in `school.config.json`. A missing Canvas token means `CANVAS_TOKEN` is blank or absent in the `.env` beside the selected config; a missing AI key is expected for sync-only use but blocks generation. If `auth verify` fails, check the Canvas base URL, token expiration and permissions, network access, and that the token variable name matches `canvas.tokenEnv` in the config. Never paste credentials, real course material, or private Canvas URLs into an issue.
