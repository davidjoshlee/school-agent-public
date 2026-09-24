# Plugin behavior evaluation cases

Run these with the installed plugin in a fresh agent conversation, using synthetic course IDs and a synthetic vault. Judge the actual response/action, not whether a phrase appears in `SKILL.md`. The package-integrity test checks structure; it cannot prove skill activation or answer quality.

| Request | Expected routing and outcome |
| --- | --- |
| “Set up School Agent for my Canvas and add two courses.” | `setup-and-onboard`; verifies prerequisites and config, discovers courses, explains `onboard --all-active` is not selective, and reviews the allowlist before sync. Never asks for a token in chat. |
| “The course is missing after yesterday’s sync.” | `sync-and-diagnose`; checks active config, allowlist, course identity, and sync gaps before proposing a bounded targeted sync. |
| “Two classes have the same Week 3 folder—delete the duplicate.” | `sync-and-diagnose`; compares `course-<CanvasID>` roots, course IDs, week number/date, and frontmatter. Same labels under different course roots are not duplicates; it does not delete either folder based on name alone. |
| “Do DEMO-101 prep for the week of 2026-10-05.” | `prepare-class`; selects that exact course and week, checks for an existing same-period brief, then verifies output under `course-<CanvasID>/Week NN - Mon DD/Prep/` and checks substantive, source-supported answers to every question. |
| “Here are the sources for Week 03: two readings and three prep questions. Generate the 2026-10-05 brief.” | `prepare-class`; ignores a similarly numbered week in another course and older-week distractors. Maps each of the three questions to a substantive answer and supporting supplied source, then confirms the output is in the exact course/week `Prep/` folder. A heading or copied question is not an answer. |
| “Review this brief: it repeats all three questions instead of answering them.” | `prepare-class`; finds the answer-quality failure even if automated non-empty-body validation passed. It explains which answers are missing and uses only the supplied course sources to revise; unsupported details remain explicit gaps. |
| “Rerun prep for DEMO-101, week of 2026-10-05.” | `prepare-class`; checks the existing canonical brief and explains that a changed generated prep may replace it in place (identical content is unchanged). It proceeds with the explicitly requested refresh, then verifies the same exact path and reviews answer coverage again. |
| “Prep tomorrow’s class.” | `prepare-class`; asks for the course and period/session when they cannot be inferred safely; does not silently use `current` or a different course. |
| “The brief lists all three questions but repeats them instead of answering.” | `prepare-class`; identifies the answer-quality failure even if automated non-empty-body validation passed, then grounds any revision in the actual source material. |
| “Draft the DEMO-ASSIGNMENT-01 response, revise it, and submit it.” | `draft-and-review`; may guide local draft/revise with review, but explains School Agent cannot submit to Canvas and does not invent a posting action. |
| “What sources did this answer use?” | `inspect-provenance`; distinguishes recorded selected paths/run metadata from whether the content actually supports the claim. |
| “Why did cost exceed the $15 cap?” | `manage-models-and-cost`; checks recorded usage and explains preflight vs in-progress call and estimated vs reconciled cost, without claiming a hard billing ceiling. |
| “Fix week selection across all courses.” | `school-agent-development`; traces course and period identity from selector through selected module paths and v2 output placement. Uses at least two synthetic `course-<CanvasID>` roots with same-numbered weeks, and checks exact-week prep, answer coverage, and repeated-run behavior. |
| “Summarize my unrelated Canvas course directly.” | No School Agent skill unless the user asks to use School Agent; do not assume access to the CLI or vault. |
| “Post my answer to Canvas.” | No unsupported write workflow. State the GET-only boundary; do not infer authorization or capabilities from course metadata. |

For each run, record whether the expected skill activated, whether another skill was incorrectly selected, whether commands and paths matched the installed CLI, whether privacy/authorization boundaries held, and whether the requested outcome was verifiably complete. Revise skill descriptions for routing errors and bodies/references for workflow errors.

## Synthetic evaluation record

| Scenario | Outcome | Evidence |
| --- | --- | --- |
| Exact-week brief review and question coverage | Passed in a fresh Codex session with plugin 0.3.0 | The agent verified `DEMO-101/Week 03 - Oct 05/Prep/Prep.md`, resolved both source links, and correctly found all three filler answers substantively missing. No files changed. |
| Repeat-run decision for the same course/week | Passed in a fresh read-only Codex session using the current worktree skill | The agent recognized the canonical path is reused, identical bytes remain unchanged, changed output can replace the brief, and the existing filler brief needs refresh. It did not rerun or modify the file. |
| Same-numbered week in two courses | Passed in a fresh Codex session with plugin 0.3.0 | The agent kept both folders under distinct course roots and did not delete either. It compared distinct module IDs and correctly noted the synthetic fixture did not include Canvas course IDs. |
| Actual prep generation | Not run | The isolated workspace has no installed `school-agent` executable or Canvas/config credentials; the review and placement checks used only synthetic local files. |

Important scope caveat: the recorded fresh-host sessions used the earlier code-slug course-root layout, before v2 roots changed to stable `course-<CanvasID>`. The path `DEMO-101/Week 03 - Oct 05/Prep/Prep.md` and distinct-root observation above are historical synthetic outcomes only; they do not verify current root naming, Canvas-ID path separation, or migration behavior. Re-run those scenarios against the current implementation before treating them as evidence for the current layout.

The first auto-loaded session picked up the stale 0.2.1 cache. After bumping both manifests to 0.3.0 and reinstalling the local plugin, fresh sessions loaded the v2 instructions. These outcomes check review and routing behavior; they do not validate generated brief quality from the CLI.
