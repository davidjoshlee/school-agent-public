---
name: prepare-class
description: Generate and review a School Agent prep brief for one explicitly identified course and week or session. Use for upcoming-class preparation; not for assignment drafting or general study advice.
---

# Prepare for a class

Use the [School Agent product map](../../school-agent.md) for broader context. Check the public [CLI reference](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/CLI.md) or installed `school-agent prep --help` for current syntax. Prep generation requires synced local course material and AI Gateway configuration.

## Generate for the intended period

1. Resolve the intended course to its exact Canvas ID or course code using the user's request and, if needed, the local course list/index. Resolve the intended week to an explicit ISO date (`YYYY-MM-DD`) or the class session identifier. Do not silently substitute today's date, `current`, the next calendar week, or another class. If the requested period is unclear, ask before generating.
2. Before generating, inspect the intended course's existing `prep/` artifacts for the same period. The current prep writer can replace a same-period brief. If one exists, preserve it or confirm that replacing it is intended before rerunning; do not rely on the CLI to version a prep brief. Then run one of:

   ```sh
   school-agent prep <course-id-or-code> --week YYYY-MM-DD
   school-agent prep <course-id-or-code> --session <session>
   ```

   The CLI accepts one period selector at a time. If the requested period has no synced materials, sync the intended course and retry; do not switch periods to force an output.
3. Capture and inspect the exact output path printed by the command. Confirm it is under the intended course's `prep/` directory and that filename/title/frontmatter identify the requested week or session. The current layout does not create a nested week directory.

## Review the brief

- Confirm the brief is finished preparation grounded in supplied readings and course sources, with usable source links; it should explain the material rather than merely tell the student what to read.
- Identify every prep question, prompt, or numbered item in the relevant synced module/assignment instructions. For each one, record whether the brief gives a substantive answer and which source supports it. A copied question, heading, generic checklist item, or nonempty filler body is **not** an answer. Mark each item answered, partially answered, unsupported, or missing; do not declare the brief complete while any item is partial, unsupported, or missing.
- The CLI's content check requires a nonempty answer subsection for each detected deliverable item. That check cannot establish relevance, correctness, completeness, or source support, and detection may miss a question. If a question is missed, an answer is unsupported, or material is unavailable, report the gap explicitly. Do not invent facts or fill gaps with plausible-sounding answers.
- Check citations resolve to the supplied vault context. Treat generation provenance as a review aid, not a correctness guarantee.
- Follow the applicable course AI policy. Stored policy metadata is informational and is not permission to use generated material.

## If the result is wrong

If course, period, or output path is wrong, stop and correct the selection before relying on the brief. If sources are stale or missing, use [sync-and-diagnose](../sync-and-diagnose/SKILL.md). Do not silently overwrite or present an unchecked brief as complete.
