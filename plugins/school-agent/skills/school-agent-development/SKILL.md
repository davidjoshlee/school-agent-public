---
name: school-agent-development
description: Build, debug, or review the School Agent TypeScript CLI, Canvas sync, vault layout, retrieval, prep, drafts, or model-routing code. Use for contributions to this product, not generic schoolwork.
---

# Develop School Agent

Use the checked-out repository as the source of truth. Read `CLAUDE.md` for project boundaries, then the relevant module and tests. `docs/OVERVIEW.md`, `docs/CLI.md`, and `docs/ONBOARDING.md` explain the user-facing flow; verify details against code when they disagree. Do not assume a private user's vault or config is available in a public clone.

## Architecture and decision points

- `src/canvas/` reads Canvas; `src/canvas/http.ts` enforces GET-only requests. Preserve read-only behavior.
- `src/store/` owns the local SQLite index and vault. `src/store/paths.ts` is the authority for vault paths; do not construct parallel week or course paths in engine code.
- `src/engines/` handles retrieval, prep, drafts, evaluation, and cost. Trace command registration from `src/index.ts` to the corresponding `*-cli.ts`, engine, and tests.
- `src/config/` and `config/models.default.json` own settings and model mappings. Keep model IDs out of source code; verify current gateway availability before recommending a change.
- Retrieval should select source context with provenance. A prep result must answer the actual questions found for the requested period, or explicitly identify unsupported answers. Tests should cover this outcome, not only file existence.
- Week/session identity must be canonical across discovery, output paths, and repeated runs. When changing period behavior, test across multiple courses and repeated sync/prep runs so fixes do not create duplicate week folders or place prep in another period.

## Safety and verification

Preserve user-owned guidance and drafts; inspect ownership and versioning rules before changing writers. Never add actual coursework, account identifiers, Canvas URLs, credentials, or vault output to fixtures or documentation. Generation transmits selected text to AI Gateway/providers; do not describe the system as wholly offline. AI-policy metadata does not enforce course policy.

Use synthetic fixtures and zero-network tests. Run `npm run typecheck`, `npm run lint`, and `npm test` for a completed code change, plus a focused regression for the behavior changed. Keep docs and command examples consistent with implemented behavior.
