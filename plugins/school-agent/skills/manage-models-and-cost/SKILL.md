---
name: manage-models-and-cost
description: Inspect School Agent model mappings, validate them against an AI Gateway catalog, and review recorded model usage and cost. Use for model routing or spend questions, not for provider billing guarantees.
---

# Manage School Agent models and cost

Start with [command-map](../../references/command-map.md) for CLI syntax and [data and privacy](../../references/data-and-privacy.md) for generation transmission and spend-cap limits.

Use `school-agent models map` to show effective function-to-model assignments, including a global model override if configured for the invocation. `school-agent models check --catalog <path>` compares mappings to a recorded AI Gateway catalog; explain that a stale catalog cannot establish current availability. Model IDs and prices are maintained in configuration/default registries, not hard-coded recommendations; verify catalog and project configuration before proposing a change.

Use `school-agent cost` to inspect locally recorded token usage grouped by function/model and distinguish estimated from Gateway-reconciled cost. `school-agent cost reconcile` requires Gateway credentials and can only reconcile eligible records. Explain gaps where usage was unavailable, the model has no price entry, or Gateway reconciliation skipped an entry; locally estimated totals may understate actual billing.

The monthly cap is a preflight check against recorded month-to-date cost and prevents a new model call once the cap is met. It does not stop or guarantee the bill for a call already underway. Do not describe it as a hard spend ceiling. If the cap blocks a task, present the reported usage and let the user decide whether to change their local setting or wait; do not silently change it.

For setup and reporting issues, consult [troubleshooting](../../references/troubleshooting.md). Keep API keys and private usage details out of shared artifacts.
