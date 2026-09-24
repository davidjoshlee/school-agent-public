# School Agent plugin

`plugins/school-agent` is a portable Agent Plugins package with seven focused skills for setup and onboarding, sync and diagnosis, class preparation, drafting and review, provenance inspection, model and cost management, and development. Its root `plugin.json` is the portable manifest. The `.codex-plugin/plugin.json` file remains as a Codex compatibility fallback; both carry the same plugin identity, version, and presentation metadata. Portable hosts discover skills from `skills/` at the plugin root.

## Install in Codex

From the repository root, add the included local marketplace and install the plugin:

```bash
codex plugin marketplace add .
codex plugin add school-agent@personal
```

Start a new Codex conversation after installation so the skills are available. Codex can select the matching focused skill from the user's task; the development skill applies when changing this repository.

## Use with another compatible host

Select or package the `plugins/school-agent` directory as the plugin root. It must include the root `plugin.json` and `skills/` directory; a host that supports the Agent Plugins portable format can discover the skills there. Hosts choose their own installation steps and may not support Codex-specific presentation metadata in `extensions.com.openai`.

## Scope and limits

This is a skills-only plugin. It contains instructions, not the School Agent CLI, a Canvas connection, credentials, or a local vault. Installing it does not install or authorize the CLI. Canvas reads and any model generation happen only when a user separately installs and runs School Agent; its normal sync is read-only, while selected local text sent for generation goes to AI Gateway and the configured model provider. Follow [the CLI guide](CLI.md) and [onboarding guide](ONBOARDING.md) for those workflows and their data boundaries.

The plugin cannot verify a user's CLI version, configuration, Canvas access, vault, or course rules. Treat its guidance as a starting point and check the installed CLI's `--help` and current documentation for version-specific behavior. The plugin does not enforce academic policy or determine whether AI use is allowed in a course.

When CLI commands or behavior change, update the relevant skill and keep its guidance aligned with `docs/CLI.md` and the implementation.

## Quality checks

Run `npm test -- test/plugin/package-integrity.test.ts` to check package identity, skill discovery, portable links, and absence of bundled access mechanisms or credential-shaped data. Use the synthetic [behavior evaluation cases](../test/plugin/evaluation-cases.md) in a fresh agent conversation to check activation and real outcomes; passing static tests alone does not establish that an agent answered prep questions well.
