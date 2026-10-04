# School Agent v0.1.1 release notes

Check [GitHub Releases](https://github.com/davidjoshlee/school-agent-public/releases/tag/v0.1.1) for the published tag and install asset. These notes do not substitute for a successful release workflow.

This version is for the macOS and Linux local CLI beta. Windows and mobile are not supported or verified. See [Onboarding](ONBOARDING.md) for the stable configuration defaults and `.env` behavior.

## What changed since v0.1.0

- First-run setup and configuration discovery use a stable user-level config location by default, while continuing to recognize a project-local `school.config.json` and explicit `--config` paths.
- The installed launcher loads the `.env` beside the selected config, so custom shell setup is unnecessary.
- Setup preserves an existing config and adjacent `.env` instead of replacing them.
- Public vault course folders use readable course names, with migration support for existing vaults.
- Vault health can report a read-only plan for reconciling stale index entries.
- `school-agent --version` reports the version from the package metadata in source, built output, and an installed release tarball.
- An opt-in `doctor --ai` checks configured model availability and authenticated synthetic generation, with sanitized guidance on authentication, credit, rate-limit, and connectivity failures.
- The dependency lockfile uses patched `undici`; CI and release checks reject high-severity production advisories.

## Defaults and costs

Setup starts with an empty explicit course allowlist, local `~/school-vault` storage, `gitInit: false`, restricted-file exclusion, a $15 monthly preflight cap, and the local index at `~/.local/share/school-agent/index.db`. Review the generated config before syncing. `doctor` is offline; `doctor --ai` is opt-in, contacts configured AI models with synthetic text, and may incur provider charges. Generation may transmit selected vault text to AI Gateway and the configured provider.

Vault folders and filenames remain human-readable. Avoid screenshots, examples, or reports containing real course names, account identifiers, Canvas URLs, tokens, or coursework when sharing diagnostics.

## Install

Use the exact `.tgz` asset URL attached to the `v0.1.1` GitHub Release after verifying that the release workflow completed successfully.
