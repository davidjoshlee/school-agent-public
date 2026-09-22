# School Agent overview

School Agent is a local-first command-line tool that reads allowlisted Canvas courses into a Markdown vault and helps you create prep briefs and draft artifacts for your review. It is intended for a personal, local workflow.

Canvas access is read-only: the tool does not post, submit, or otherwise change Canvas. AI-policy values are informational metadata, not enforcement. You must follow the rules that apply to your school, instructor, and course.

## How it works

```
Canvas (read only) → local vault + SQLite index → selected context → prep or draft → your review
```

1. `sync` reads the courses in your allowlist and writes Markdown documents to your local vault. It also maintains a local SQLite index for searching and tracking work.
2. For a generation request, retrieval selects relevant local material rather than sending an entire course at once.
3. `prep` creates a brief; `draft` creates a draft that remains subject to your review and approval. Revision and approval are durable local filesystem states.
4. Optional simulation and comparison commands support evaluation against a chosen historical window. They are evaluation tools, not a promise of academic quality.

## Privacy and boundaries

The vault and index are local files. A generation request transmits selected vault text to AI Gateway and the model provider used for that request. Restricted files are excluded by default; changing that setting is your responsibility and should be consistent with applicable course rules.

The tool records provenance and model-context information to help you inspect a run. That information is useful for review, but it does not guarantee that a draft is complete, correct, non-infringing, or permitted by a course policy. Verify sources, calculations, and final work yourself.

Derived values can be routed through a calculator and reviewed against a calculation log. This is an aid to checking work, not a security boundary or a guarantee against errors. In particular, model-produced JavaScript evaluated with Node's `vm` must not be treated as an unconditional filesystem or network sandbox.

## Local layout

A new setup defaults to:

- Vault: `~/school-vault` (not initialized as a Git repository)
- Index: `~/.local/share/school-agent/index.db`
- Course mode: explicit allowlist, initially empty
- Restricted-file handling: `exclude`
- Monthly model-spend preflight cap: $15

The vault is content; the repository is code. Do not commit or share vault material, tokens, `.env`, or `school.config.json`.

## Costs

Before a model call, School Agent checks the configured monthly cap using recorded usage. This preflight cannot guarantee a billing ceiling for an in-progress request. Costs are initially local estimates; where supported, `cost reconcile` can replace eligible estimates with AI Gateway-reported values. Review `school-agent cost` regularly.

## Start here

On macOS or Linux with Node.js 22 or newer:

```bash
school-agent setup --canvas-url https://canvas.example.edu
school-agent doctor
school-agent auth verify
school-agent courses list --all
school-agent onboard --all-active
school-agent sync
```

Windows has not been verified. See [Onboarding](ONBOARDING.md) for installation and [CLI reference](CLI.md) for commands.
