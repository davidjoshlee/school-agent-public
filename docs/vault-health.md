# Vault health audit

`planVaultHealth({ root, indexPath })` performs a read-only consistency audit of a v2 Markdown vault and its SQLite index. It reports duplicate numbered Week directories, missing paths referenced by the index (with file rows reported separately), and course roots with a manifest that are not referenced by the `courses` table. Course roots recorded in SQLite that no longer exist are also reported.

The result includes a `repairPlan` for human review. Every proposed action is explicitly marked `automatic: false`; planning never renames directories, edits Markdown, or writes to SQLite. A repair should only be applied after resolving ownership and choosing the canonical path. The audit opens the supplied database read-only and requires it to exist.
