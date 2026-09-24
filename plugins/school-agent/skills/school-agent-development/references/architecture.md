# Architecture seams for maintainers

Read this when a change spans commands, storage, retrieval, or generation. Source paths below locate the authority in a checkout; inspect current code before editing.

| Concern | Authority | Downstream effect |
| --- | --- | --- |
| CLI entry and global options | `src/cli.ts` | Registers command families; `--config` and `--model` apply to runs. |
| Canvas access | `src/canvas/http.ts`, `src/canvas/sync.ts` | GET-only transport feeds synced vault documents and index. |
| Course selection | `src/canvas/onboard-cli.ts`, `src/config/` | Explicit allowlist determines what `sync` may read. |
| Vault path and ownership | `src/store/paths.ts`, `src/store/vault.ts` | Every writer/reader must agree on course, module, prep, draft, and final locations. |
| Retrieval | `src/engines/retrieve-selection.ts`, `src/engines/retrieve.ts` | Known module targets are preferred; keyword fallback is recorded when no module matches. |
| Prep requirements | `src/engines/requirements.ts`, `src/engines/deliverable.ts`, `src/engines/prep.ts` | Course guidance and detected deliverables determine sections/questions; validation gates output. |
| Model and cost | `config/models.default.json`, `src/models/` | Configurable mapping, preflight cap, usage record and reconciliation. |

Do not solve a path or week bug only in the presentation layer. Trace identity from Canvas/module dates through selection, filename/frontmatter, writer ownership, and a repeat run across at least two courses.
