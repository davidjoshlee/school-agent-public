# Product concepts

School Agent syncs allowlisted Canvas content into a local Markdown vault and SQLite index. Prep and draft workflows select relevant local context; Canvas access remains read-only. See the public [overview](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/OVERVIEW.md) and the plugin's [product map](../school-agent.md) for the broader flow.

For generated work, distinguish these states:

- A draft is a local artifact under the course's `drafts/` directory. Its provenance records assignment/course identifiers, policy metadata, model IDs, source paths, timestamp, version, and run ID.
- `revise <run-id>` creates another version; it does not edit or replace a pending draft in place.
- `approve <run-id>` promotes the local artifact into `final/`. It does not submit to Canvas.
- Automated correctness notes and provenance aid human review; neither guarantees correctness or compliance with course rules. Policy metadata is informational.

Paths are defined centrally in `src/store/paths.ts`; layout and ownership are described in the public [vault-layout guide](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/vault-layout.md). Check current code for defaults or behavior that may have changed.
