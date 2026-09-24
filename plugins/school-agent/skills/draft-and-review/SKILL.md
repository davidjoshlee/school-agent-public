---
name: draft-and-review
description: Create, revise, and critically review School Agent assignment drafts in the local vault. Use for draft workflow help; it does not submit work to Canvas or determine whether AI use is permitted.
---

# Draft and review School Agent work

Use the School Agent CLI to create local drafts, inspect their evidence, and revise or approve them only as the user directs. For command syntax see [command-map](../../references/command-map.md); for the meaning of local draft and approval states see [product-concepts](../../references/product-concepts.md).

Before generation, confirm the intended assignment and course, check relevant course rules, and inspect the available source material. Generation sends selected local vault text to AI Gateway and the provider; consult [data and privacy](../../references/data-and-privacy.md) when the data flow matters. AI-policy metadata is informational and is not permission to use AI.

After `school-agent draft <assignment>`, capture the reported run ID and path. Read the artifact itself, including its `## Correctness check` and missing-source notices. Check that each assignment requirement is answered, claims and quotes have support, and derived numbers match the included computations. Treat automated review as a review aid, not proof. Inspect provenance and selected-source records when source coverage is uncertain; request or ingest missing material instead of guessing.

If the user requests changes, use `school-agent revise <run-id> [feedback]`; inspect the new version and its refreshed review note. The versioned draft workflow preserves prior artifacts. Run `school-agent approve <run-id>` only when the user explicitly asks to promote the reviewed draft. Approval writes to the assignment's local `Final/` directory; it is not a Canvas submission. Never infer permission to submit, post, or send work elsewhere.

For common missing-source, run-ID, and model issues, consult [troubleshooting](../../references/troubleshooting.md). Keep real coursework, vault content, credentials, and private course details out of shared files and examples.
