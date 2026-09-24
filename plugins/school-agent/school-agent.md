# School Agent product map

School Agent is a local-first CLI for a student's own Canvas courses. It reads an explicit course allowlist into a Markdown vault and SQLite index, then uses selected local context to generate prep briefs and assignment drafts for human review. The plugin gives agents product knowledge; it does not provide credentials, access to a vault, or an MCP connection.

## Flow and ownership

```text
Canvas GETs (allowlisted courses)
  → sync → per-course vault + SQLite index
  → retrieval (module-first when a target is known; keyword fallback otherwise)
  → prep / draft → local artifact + provenance → human review
```

- `src/canvas/`: authentication, course discovery, allowlist onboarding, GET-only HTTP, sync and ingest.
- `src/store/`: vault path vocabulary and ownership-aware writer, frontmatter, manifests, SQLite index.
- `src/engines/`: retrieval and source selection, prep, drafting, evaluation, and cost flows.
- `src/agents/`: model runner, run records and tools.
- `src/config/` and `config/models.default.json`: setup, validation, default model mappings; user config may override.
- `src/cli.ts`: CLI registration and global options. Installed binary is `school-agent` (also `school`).

For an installed version, `school-agent --help` is the command authority. In a source checkout, inspect the command's `*-cli.ts` and engine before advising a repair or changing behavior. The [public CLI reference](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/CLI.md) and [overview](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/OVERVIEW.md) are orientation, not substitutes for current code.

## Workflow routing

| User goal | Skill |
| --- | --- |
| Install, configure, or select courses | `setup-and-onboard` |
| Refresh material or diagnose duplicate/missing content | `sync-and-diagnose` |
| Complete prep for a named week/session | `prepare-class` |
| Draft, revise, or approve local assignment work | `draft-and-review` |
| Check cited sources, selected context, or output provenance | `inspect-provenance` |
| Understand model mappings, usage, or spend | `manage-models-and-cost` |
| Change or review the implementation | `school-agent-development` |

## Non-negotiable boundaries

- Canvas access remains GET-only. School Agent does not submit, post, or fetch replies.
- AI-policy fields are metadata, not enforcement or permission. Verify course rules.
- Vault and index are local, but generation sends selected text to AI Gateway/model providers. Restricted files default to exclusion.
- A prep artifact exists under the course's `prep/` directory with period identity in its name/frontmatter; do not assume a nested week directory. A successful run and non-empty answer bodies do not prove that prep questions were answered correctly.
- Approval moves a local draft toward `final/`; it is not submission to Canvas.
- Real vault content, config, tokens, student identities, and coursework never belong in this public plugin or its tests.
