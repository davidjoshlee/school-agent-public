# Public release checklist

This checklist tracks the clean-history public source release ([tracking issue #6](https://github.com/davidjoshlee/school-agent-public/issues/6)). Private development history and local course content are excluded.

## Completed in the public export

- [x] Replace public test and documentation examples with synthetic material.
- [x] Add a generic setup flow with explicit Canvas URL, `doctor`, an empty course allowlist, conservative local defaults, and non-overwriting setup behavior.
- [x] Document that the launcher loads a `.env` adjacent to its configuration and that sync can run without an AI Gateway key.
- [x] Add MIT licensing and community files: contribution guidance, security-reporting guidance, issue templates, and a pull-request template.
- [x] Document read-only Canvas behavior, provider transmission of selected text for generation, restricted-file defaults, academic-policy responsibility, and cost limitations.
- [x] Add calculator hardening and regression coverage. Node’s `vm` remains explicitly documented as not being a security boundary.
- [x] Run package-oriented checks appropriate to the export, including build and package-content validation.

## Required before publication

- [x] Run the full typecheck, lint, mocked test suite, build, and isolated install/package smoke test from a clean checkout.
- [x] Perform a final repository and package audit for credentials, signed URLs, personal identifiers, local paths, and course material. Report findings by path only; do not copy sensitive values into issues or logs.
- [x] Confirm the public history is clean and contains only the audited export.
- [x] Review the generated package file list before publishing or attaching an archive.
- [ ] Activate the Linux/macOS CI workflow ([issue #1](https://github.com/davidjoshlee/school-agent-public/issues/1)). GitHub rejected workflow creation because the authenticated token lacks `workflow` scope. The inert [workflow template](ci-workflow.example.yml) is ready for a maintainer with that permission to install.
- [x] Verify an anonymous public clone, fresh dependency installation, build, and packaged setup/doctor workflow on macOS with Node.js 24. Linux and Node.js 22 matrix verification remain pending CI activation.

## Acceptance after publication

- [ ] Complete an opt-in friend acceptance test ([issue #2](https://github.com/davidjoshlee/school-agent-public/issues/2)): fresh installation, setup, `doctor`, token verification, allowlist selection, sync, and an initial prep workflow using that tester’s own credentials.
- [ ] Record only synthetic or tester-approved, non-sensitive feedback. Do not collect course materials, credentials, or private Canvas URLs.
- [ ] Confirm the tester understands that Canvas access is read-only, AI-policy metadata is not permission or enforcement, and selected text is sent to the configured AI Gateway/provider for generation.

## Ongoing release guardrails

Follow-up work is tracked for [calculator isolation](https://github.com/davidjoshlee/school-agent-public/issues/3), [model pricing and budgets](https://github.com/davidjoshlee/school-agent-public/issues/4), and [offline demos and Windows](https://github.com/davidjoshlee/school-agent-public/issues/5).

- Never add real coursework, vault content, access tokens, `.env` files, personal configuration, signed download URLs, or private identity details to public source, test fixtures, documentation, archives, or release notes.
- Keep Canvas writes, submissions, and discussion replies out of scope.
- Treat cost estimates and the monthly preflight cap as advisory controls; an ongoing model call can exceed a preflight estimate.
- Do not claim Windows support until it is verified.
