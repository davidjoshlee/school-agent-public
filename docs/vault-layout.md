# Vault layout

The vault is a local-only Markdown workspace. Every layout path is defined in
`src/store/paths.ts`; consumers must use that module rather than constructing a
vault path themselves. `_meta/layout.json` records the current layout version.
Future restructures change that authority and run `school vault migrate`.

## Root metadata

`_meta/` stores operational records, not course material:

- `layout.json` — layout version.
- `sync-log.md` — sync history.
- `capability-matrix.md` — supported Canvas capabilities.
- `auth.json` — token expiry metadata; never a Canvas token.
- `ALERT.md` — actionable alerts.
- `model-context-log.jsonl` — model context provenance.

## Course tree

Each course lives in a deterministic, APFS-safe course-code directory:

```text
<course-code>/
├── 00-syllabus.md
├── _index.md
├── modules/<NN>-<slug>/
├── assignments/
├── announcements/
├── files/                 # downloaded assets and Markdown sidecars
├── prep/
├── guidance/
├── drafts/
└── final/
```

The per-course `_meta/course-playbook.md` accumulates instructor feedback
patterns. `_index.md` is the per-course content manifest for two-tier context
selection.

## Document contract

Every generated Markdown document has YAML frontmatter with `canvas_id`,
`canvas_url`, `type`, `dates`, `content_hash`, `source`, `status`, `ai_policy`,
and `redistribution`. `source` is `sync`, `agent`, or `user`; `status` is
`draft`, `approved`, or `final`. Restricted material is marked
`redistribution: restricted`.

## Ownership zones

- Synced course content is agent-owned and can be rewritten.
- A guidance template is written once and is never overwritten.
- A pending draft is never overwritten; the next engine output receives a
  deterministic `.vN` sibling.
- If a synced document's frontmatter says `source: user`, the original is
  preserved and new Canvas material is written to a `.canvas-update` sibling.
- An iCloud `.icloud` placeholder is warned about and skipped.

Writes compare complete bytes before writing, so identical content preserves the
file and its mtime.

## Local git history

When `vault.gitInit` is enabled (the default), the writer initializes a Git
repository inside the vault and commits each write with a structured message.
It never configures a remote; the repository is only local undo history.
