# Prep contract

Read this for prep or period-selection changes. Confirm current behavior in `src/engines/prep-cli.ts`, `prep.ts`, `retrieve-selection.ts`, `requirements.ts`, `src/store/paths.ts`, `src/store/vault.ts`, and the focused prep/store tests.

1. CLI accepts `prep <course>` with either `--week <value>` or `--session <value>`, not both. In week mode without an explicit value, it currently requests `current`; explicit dates are preferable for reproducibility.
2. `selectModulesForPeriod` uses module structure and date/session signals. If selection falls back to keywords, do not assume the selected material represents the requested period. Review the selected paths and source dates before relying on the brief.
3. `generatePrepBrief` resolves guidance and deliverable items from selected sources, prompts for a completed brief, validates required sections and links, and writes a local prep artifact.
4. When deliverables are detected, `validateAnswers` checks each expected question/item heading and a non-empty answer body. It does **not** establish factual correctness, depth, or whether the body truly answers the question. Tests and human review must cover those qualities.
5. The v2 tree groups course material under chronological containers: `Week NN - Mon DD/` or `Milestone NN - Title/`, each with `Prep/`, `Materials/`, `Other/`, and `00 Overview.md`. `prepPeriodPlacement(selection)` derives placement from a selected module path beginning with `Week` or `Milestone`; without that selection, prep can land at course-level `Other/Prep/`. Verify both the printed path and `dates.period` before describing the result as exact-week prep.
6. A repeated prep run targets the same canonical path. The writer leaves identical bytes unchanged and can replace changed `source: agent`, `status: auto-final` prep content in place; it does not create draft-style version siblings. Preserve existing work or get confirmation that a refresh is intended before rerunning.

For a reported duplicate/misplaced-week bug, reproduce with synthetic courses and repeated runs. Compare course identity, module date signals, period resolution, vault paths, frontmatter, and result paths. Same-numbered weeks in different course-code roots are distinct. Preserve unrelated weeks and user-owned content; do not collapse folders based on name similarity alone.
