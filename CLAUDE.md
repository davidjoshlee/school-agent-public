# CLAUDE.md — school-agent

Local-first Canvas school agent. TypeScript ESM, Node.js 22 or newer, tsx, zod, better-sqlite3, Vitest, and Biome. Support macOS and Linux; Windows is unverified.

## Purpose and boundaries

The tool reads allowlisted Canvas courses into a local Markdown vault and can generate prep briefs and draft artifacts for the user’s review.

- **Canvas is read-only.** `src/canvas/http.ts` rejects non-GET requests. Never add Canvas writes, submissions, posts, or reply fetching.
- **AI policy is metadata, not enforcement.** Record disclosed policy metadata and provenance, but do not claim that metadata grants permission or that the tool enforces a school policy. The user remains responsible for applicable rules.
- **Local storage, provider transmission.** Vault and index are local. Generation sends selected text to AI Gateway/providers; restricted files default to exclusion. Do not claim all course material stays local or that generated text cannot be wrong.
- **Secrets and course material stay private.** Never commit or place real course data, Canvas URLs, identities, tokens, `.env`, user configuration, or vault content in fixtures, docs, issues, or logs.
- **Calculator caution.** Node's `vm` is not a security boundary for model-generated JavaScript. Do not promise unconditional filesystem or network isolation.

Default setup creates `~/school-vault`, an empty explicit course allowlist, `gitInit: false`, restricted-file handling `exclude`, a $15 monthly preflight cap, and an index at `~/.local/share/school-agent/index.db`. It must not overwrite an existing `school.config.json` or adjacent `.env`.

## Architecture

`sync` (Canvas to vault and SQLite index) → per-course manifest → budget-aware retrieval → `prep` / `draft` engines → local review and approval. Optional `simulate`, `compare`, and `gate m1` support human-reviewed historical evaluation.

- Vault paths derive from `src/store/paths.ts`; do not duplicate layout strings.
- Retrieval uses manifests and summary sidecars before selected full text. Record selected model context locally.
- Draft approval is durable local state. User guidance is never overwritten; revisions create versions.
- Model IDs belong in `config/models.default.json` and user config overrides, not source files.
- Cost preflight happens before model calls, but cannot promise an absolute billing ceiling for a request already in progress. Reconcile eligible recorded costs with the provider when possible.

## Commands

For installed users: `school-agent setup --canvas-url https://canvas.example.edu`, then `school-agent doctor`, `auth verify`, `courses list --all`, `onboard --all-active`, and `sync`. The launcher loads a `.env` next to `school.config.json`; no custom shell configuration is required.

For development, use `npx tsx src/index.ts [--config school.config.json] [--model <id>] <cmd>` as applicable. Keep command examples synthetic.

Before committing, run:

```bash
npm run typecheck
npm run lint
npm test
```

## Conventions

- Strict TypeScript: no `any`; preserve bracket access required by `noPropertyAccessFromIndexSignature`.
- ESM NodeNext imports use `.js` suffixes.
- Keep files under the documented size ceiling unless an explicit exception is appropriate.
- Tests use Vitest and MSW with zero network. Live access belongs only to explicit user-invoked commands.
- No dependencies without an accompanying test. UI and vector-database dependencies remain out of scope.

## References

- `README.md` and `docs/ONBOARDING.md` — installation and user workflow
- `docs/CLI.md` — command reference
- `docs/DECISIONS.md` — technical lessons; sanitize before publishing
- `docs/ROADMAP.md` — historical planning context, not public policy or current defaults
