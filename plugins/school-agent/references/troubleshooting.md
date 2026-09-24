# Troubleshooting

Start with the installed CLI's `--help`, `school-agent doctor`, and, for a Canvas credential issue, `school-agent auth verify`. Do not request that the user reveal a token. See public [onboarding](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/ONBOARDING.md) for setup and the [CLI reference](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/CLI.md) for documented flags.

- **No course or assignment found:** check the saved allowlist and local index; sync the intended course, then retry using its course code or assignment ID. A targeted sync does not change the saved allowlist.
- **No useful draft sources or missing required sources:** inspect source paths in the draft provenance and relevant local assignment, syllabus, module, and file documents. Sync or ingest only material the user intends to use. Preserve explicit missing-source notices; do not fill gaps by guessing.
- **Draft cannot be revised/approved:** verify the run ID and that its provenance-bearing Markdown remains under the vault's assignment `Drafts/` path. The CLI locates runs from local draft artifacts.
- **Monthly cap reached:** no model call is made when preflight finds recorded month-to-date usage at or above the configured cap. Inspect `school-agent cost`; changing the cap is a user configuration choice. The cap cannot bound an in-progress provider bill.
- **Model mapping check fails:** inspect `school-agent models map`; check mappings against an available recorded Gateway catalog with `models check --catalog <path>`. Catalog check is only as current as that file.
- **Usage/cost discrepancy:** `cost` reports recorded estimates and reconciled rows; use `cost reconcile` when Gateway credentials are configured and eligible generation IDs exist. Reconciliation can skip rows without usable generation information.

For implementation-level investigation, trace command registration to the corresponding CLI and engine under `src/`; confirm behavior against code and docs rather than inferring it from an error message.
