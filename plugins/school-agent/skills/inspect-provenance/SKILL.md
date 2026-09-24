---
name: inspect-provenance
description: Explain or inspect source selection and run provenance for School Agent prep or assignment outputs. Use when evaluating what local material informed a run; provenance is evidence for review, not a correctness guarantee.
---

# Inspect School Agent provenance

Use the output artifact and local vault records to establish what School Agent says it used. Read [product-concepts](../../references/product-concepts.md) for artifact semantics and [data and privacy](../../references/data-and-privacy.md) before sharing or transmitting any content.

For assignment drafts, inspect the `school-agent-provenance` metadata in the Markdown artifact. It records course and assignment identity, AI-policy metadata, model IDs, source file paths, timestamp, version, and run ID. Compare the source paths with the assignment's requirements and the local vault documents; identify absent, stale, or apparently incomplete coverage. The metadata does not prove that a listed source was sufficient or that unlisted material was irrelevant.

For generation context selection, the vault root `_meta/model-context-log.jsonl` records run/function, provider and model, selected source paths and tiers, plus selection mode and module details when applicable. Match by run ID where available. This log records selection metadata, not a complete transcript or a guarantee that selected text answers the task.

When explaining a result, distinguish direct evidence (recorded path/model/run metadata) from inference (whether that set adequately supports a particular claim). Do not expose private source text unnecessarily. If evidence is missing, say so and inspect the installed version and local artifact. For source-gap troubleshooting see [troubleshooting](../../references/troubleshooting.md).
