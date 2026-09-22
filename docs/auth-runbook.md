# Canvas authentication runbook

Use a Canvas access token issued for your own account and store it as a secret. This guide uses the synthetic host `https://canvas.example.edu`; use your institution’s actual Canvas host in setup.

## Configure the token

1. In Canvas, open your account settings and create an access token following your institution’s instructions. Record any expiration Canvas displays before closing the page.
2. Put the token in a `.env` file next to `school.config.json`:

   ```dotenv
   CANVAS_TOKEN=replace_with_your_canvas_token
   ```

3. Run:

   ```bash
   school-agent doctor
   school-agent auth verify
   ```

The installed launcher automatically loads the adjacent `.env`. Do not put a token in a command argument, issue, screenshot, vault, or committed configuration file.

`doctor` reports a missing Canvas token as an error. It reports a missing AI Gateway key as a warning because sync can run without generation.

## Renewal and troubleshooting

Run `school-agent auth status` to inspect recorded token state when available. If Canvas rejects the token, create a replacement in Canvas, update the adjacent `.env`, and run `school-agent auth verify` again.

If verification fails, check the configured Canvas URL, token expiration, account access, and network connection. Contact your institution’s Canvas support channel for an access or scope problem. Do not work around an access restriction by scraping browser sessions or attempting unsupported authentication flows.

Canvas requests made by School Agent are read-only. The tool does not submit assignments, post replies, or modify course data.
