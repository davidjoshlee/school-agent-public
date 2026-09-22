# Onboarding

This guide sets up a personal local installation. It uses synthetic examples; replace `https://canvas.example.edu` with your institution’s Canvas URL.

## Requirements

- macOS or Linux
- Node.js 22 or newer
- A Canvas access token (an AI Gateway API key is needed only for generation)

Windows has not been verified. You do not need a custom shell function, zsh configuration, or a cloud account for vault storage.

## Install and initialize

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

If `doctor` or `auth verify` fails, first check the Canvas URL, token, network access, and that `.env` sits next to `school.config.json`. Never paste credentials or real course material into an issue.
