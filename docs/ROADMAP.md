# School Agent roadmap

School Agent is a local-first, read-only Canvas companion. It stores a personal Markdown vault and local index, then can prepare briefs and draft artifacts for the user’s review. Canvas writes, submissions, and discussion replies are out of scope.

AI-policy metadata is disclosure, not enforcement or permission. Users are responsible for the academic and privacy rules that apply to their own courses.

## Current product baseline

- Install on macOS or Linux with Node.js 22 or newer; Windows remains unverified.
- Initialize a new installation with `school-agent setup --canvas-url https://canvas.example.edu`.
- Use an explicit, initially empty course allowlist. New defaults use `~/school-vault`, no vault Git initialization, restricted-file handling set to `exclude`, a local index, and a $15 monthly preflight cap.
- Keep vault and index locally. A generation request can transmit selected vault text to AI Gateway and the selected model provider.
- Provide a read-only Canvas sync, local retrieval, prep and draft workflows, provenance, revision/approval state, and optional evaluation commands.

## Near-term priorities

1. **Reliable first-run experience**
   - Keep setup non-destructive: do not overwrite an existing configuration or adjacent `.env`.
   - Maintain `doctor` checks that distinguish required Canvas access from optional generation credentials.
   - Improve actionable diagnostics for configuration, token expiration, filesystem paths, and provider setup.

2. **Safe local workflow**
   - Preserve the Canvas read-only boundary and explicit course allowlist.
   - Keep restricted material excluded from remote model context by default.
   - Make provenance, selected-source records, and local approval states easy to inspect.
   - Continue using synthetic fixtures and examples in the public repository.

3. **Quality and cost visibility**
   - Improve source selection, missing-source signaling, and review aids without presenting them as correctness guarantees.
   - Show estimated usage clearly and reconcile eligible usage with provider-reported cost where supported.
   - Improve budget behavior for concurrent and in-flight model calls; a preflight cap cannot guarantee a billing ceiling for a request already underway.

4. **Portability and release quality**
   - Maintain Linux and macOS installation, build, test, and package-smoke coverage on supported Node versions.
   - Verify Windows before claiming support.
   - Keep package contents, documentation, and public fixtures free of credentials and course content.

## Longer-term evaluation

- Conduct opt-in acceptance testing with independent users using their own credentials and course-policy review.
- Evaluate calculator isolation with an operating-system security boundary if arbitrary model-generated code must be treated as untrusted. Node’s `vm` is not that boundary.
- Consider offline demos and additional accessibility or workflow improvements only after the core local workflow remains dependable.
