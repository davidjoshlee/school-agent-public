# Prep contract

Read this for prep or period-selection changes. Confirm current behavior in `src/engines/prep-cli.ts`, `prep.ts`, `retrieve-selection.ts`, `requirements.ts`, and `test/prep*.test.ts`.

1. CLI accepts `prep <course>` with either `--week <value>` or `--session <value>`, not both. In week mode without an explicit value, it currently requests `current`; explicit dates are preferable for reproducibility.
2. `selectModulesForPeriod` uses module structure and date/session signals. If no module matches, retrieval degrades to keyword fallback. A produced brief therefore needs provenance review; the selected text may not represent the requested period.
3. `generatePrepBrief` resolves guidance and deliverable items from selected sources, prompts for a completed brief, validates required sections and links, and writes a local prep artifact.
4. When deliverables are detected, `validateAnswers` checks each expected question/item heading and a non-empty answer body. It does **not** establish factual correctness, depth, or whether the body truly answers the question. Tests and human review must cover those qualities.
5. `courseDocumentPath` currently places prep at `<course>/prep/<slug>.md`; period is carried in title, synthetic Canvas ID, and frontmatter `dates.period`. Do not assert a nested week-folder contract the code does not implement.

For a reported duplicate/misplaced-week bug, reproduce with synthetic courses and repeated runs. Compare module date signals, period resolution, vault paths, frontmatter, and result paths. Preserve unrelated weeks and user-owned content; do not collapse folders based on name similarity alone.
