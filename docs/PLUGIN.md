# School Agent plugin

The repository includes an optional Codex plugin at `plugins/school-agent`. It teaches coding agents how School Agent works and helps users operate the CLI. It does not contain credentials, connect to Canvas, or install School Agent itself.

From a cloned repository, add its local marketplace and install the plugin:

```bash
codex plugin marketplace add .
codex plugin add school-agent@personal
```

Start a new Codex conversation after installation so its two skills are discoverable. You can invoke `school-agent-use` for setup, sync, prep, and draft review, or `school-agent-development` when changing the code. Other agents that support the open `SKILL.md` convention can read the skill files directly; their installation mechanism may differ.

The plugin is skills-only. It supplies instructions, not a live integration or authorization. Future tool access could use an MCP server with explicit read-only scopes, but should not expose local vault data or Canvas credentials by default.

The plugin's knowledge should evolve with code and docs. When commands or behavior change, update the relevant skill and test that its guidance still matches `docs/CLI.md` and the implementation.
