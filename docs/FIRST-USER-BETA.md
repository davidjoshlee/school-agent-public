# First-user beta acceptance

This checklist defines the first-user beta for the local School Agent CLI. The current candidate is `v0.1.1`; it is not published until the release is available on GitHub Releases. Record the exact installed version during every acceptance run.

## Beta scope

The beta is for one person using the CLI locally on macOS or Linux with Node.js 22 or 24. The user supplies and controls their own Canvas credentials, chooses one Canvas course, syncs that course, and reviews one dated prep brief. This verifies a narrow personal workflow; it does not establish general compatibility across institutions, course designs, or platforms.

The first-user workflow is accepted only when all of these are true:

1. The installed `school-agent --version` reports the candidate version.
2. Setup and offline `doctor` complete using the user's own config location and credential setup.
3. The user verifies Canvas access, identifies the intended course, and confirms the allowlist contains only that course before syncing.
4. A targeted sync completes for that course.
5. Prep creates a brief for an explicitly dated week or session.
6. The user opens the brief, checks its provenance/source list against the material they expected from Canvas, and judges whether the brief accurately represents that material. Record gaps or misleading statements as failures, even if the command exits successfully.

Use a real, authorized first-user run for this acceptance. Automated package smoke and synthetic tests cover packaging and config selection, but they do not count as a live user acceptance or as evidence of Canvas source coverage or prep accuracy. Until a friend completes and reports the workflow, the first-user check remains pending.

## Boundaries

- Supported beta use is the macOS/Linux local CLI. Windows, iPhone, other mobile use, and cloud or hosted workflows are outside the beta.
- The beta does not promise Google Drive ingestion or access.
- Canvas access is read-only. The workflow does not post, submit assignments, or change Canvas data.
- The user remains responsible for selecting permitted course material and following school and instructor rules. AI-policy metadata is informational.
- Sync and ordinary `doctor` do not call an AI provider. Prep may transmit selected local course text to AI Gateway and its model provider. Review course rules and privacy obligations first.
- `doctor --ai` is optional and makes bounded synthetic requests for distinct configured models (or the global `--model` override). Provider calls may be billed; probe charges are not recorded in the local cost ledger and are not governed by its monthly cap. Review Gateway-side budgets before opting in.
- A successful command is not proof that a brief is complete or correct. The user must inspect its sources and content.
- The Codex plugin is optional and independent of the CLI install and release. It is not bundled with the CLI and is not required for acceptance.

## Acceptance record

Keep a short, sanitized record with:

| Field | Record |
| --- | --- |
| Installed version | Exact output of `school-agent --version` |
| Date and platform | Date, macOS/Linux version, and Node.js version |
| Course scope | “One course” and whether the allowlist was checked; do not record course names or IDs publicly |
| Sync | Pass/fail and a sanitized error summary if it failed |
| Dated prep | Pass/fail and the selected week/session date |
| Source coverage | Whether expected synced material appeared in provenance; describe omissions without quoting course content |
| Output accuracy | User's judgment and concise sanitized examples of any issue, without course text or personal data |
| Follow-up | Reproduction notes that contain no token, private Canvas URL, identity, or course material |

Do not attach `.env`, `school.config.json`, logs containing private paths or identities, vault files, tokens, Canvas URLs, or coursework. Redact before sharing a failure report.

## Maintainer checks

Before inviting a first user, run the repository's zero-network tests and installed tarball smoke check. The smoke check verifies the packaged version, default setup under an isolated home, doctor from a different working directory, and explicit/current-directory/user-level config precedence. It must not use a real Canvas account, a paid model, or the maintainer's home config or vault.

Passing maintainer checks establish package behavior only. Release readiness still requires the live first-user record above; do not mark that acceptance complete from synthetic fixtures or an unshared local run.
