---
name: school-agent-development
description: Implement, debug, or review changes to the School Agent TypeScript CLI and its Canvas sync, vault, prep, draft, retrieval, model, or cost modules. Use for source-code work in this product, not ordinary course prep.
---

# Develop School Agent

Use the checked-out repository as the source of truth. Read its `CLAUDE.md`, then the relevant module and tests. For package-level context, read [the product map](../../school-agent.md). An installed plugin is not itself a source checkout; locate the repository before citing or editing source files. Do not assume a private user's vault or config is available in a public clone.

## Architecture and decision points

- Trace commands from `src/cli.ts` to the owning `*-cli.ts`, engine, and tests. Use [architecture](references/architecture.md) when changing a cross-module seam.
- Canvas HTTP is GET-only. `src/store/paths.ts` owns vault layout; avoid competing path construction. Use [vault ownership](references/vault-ownership.md) before changing writers or migration behavior.
- For prep or period selection, read [the prep contract](references/prep-contract.md). The output is a per-course `prep/` file, not currently a nested week directory. Preserve one canonical week/session identity across selection, output, and reruns.
- Model IDs belong in `config/models.default.json` and user overrides, not source files. Verify gateway availability before proposing a different default.

## Safety and verification

Preserve user-owned guidance and drafts. Never add actual coursework, account identifiers, Canvas URLs, credentials, or vault output to fixtures or documentation. Generation transmits selected text to AI Gateway/providers; do not describe the system as wholly offline. AI-policy metadata does not enforce course policy. Node `vm` is not a security boundary for model-generated JavaScript.

Use synthetic fixtures and zero-network tests. For a completed code change, run a focused regression plus `npm run typecheck`, `npm run lint`, and `npm test`. A prep fix needs assertions about question coverage and period/course identity, not only file creation. Keep docs and examples consistent with implemented behavior.
