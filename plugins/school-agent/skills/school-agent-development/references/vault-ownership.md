# Vault ownership and migration

Read this before changing a vault writer, sync path, migration, or guidance behavior. `src/store/paths.ts` defines the layout vocabulary; `src/store/vault.ts` and `src/store/vault-document.ts` own writes and frontmatter. The v2 tree groups course material by `Week NN - Mon DD/` or `Milestone NN - Title/`, with `Prep/`, `Materials/`, and `Other/` beneath each period; assignments keep `Drafts/`, `Final/`, and feedback in their assignment folder. The public [vault-layout guide](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/vault-layout.md) is useful orientation, but verify source and tests.

- Synced material may be refreshed by sync. A document marked `source: user` must not be overwritten by Canvas content; the writer uses a `.canvas-update` sibling.
- User guidance is preserved. Pending drafts use deterministic version siblings rather than overwriting prior work. Generated prep is auto-final and may be refreshed in place at the same period path.
- Identical complete bytes preserve a file and its mtime. iCloud placeholders are skipped with warnings.
- Vault Git is optional and local-only when enabled; new setup currently defaults it off. Never assume a remote or treat vault history as safe for publication.
- Layout migration is an explicit concern. Diagnose and test exact source/target paths before rewriting or deleting material; use synthetic vault fixtures, not a user's live vault, for development tests.
