# Private upgrade parity check

The public test suite uses synthetic Canvas and model fixtures. Before changing a personal pinned runtime, compare the old and candidate releases against **separate copies** of the same private vault and SQLite index. Never point two runtimes at the live vault or publish either copy.

The optional runner below makes the copies and runs each CLI's `doctor`. Without `--sync`, it does not sync or compare vault contents. Add `--sync` to opt into syncs; only then does it run `parity-compare.mjs`. Repeated `--sync-arg VALUE` options are passed identically to both sync commands. It accepts the Node launcher path from each runtime (normally `bin/school.js`). The original vault root comes from the supplied config, so `--vault` may point to a separate backup copy.

```sh
node scripts/parity-sandbox.mjs \
  --vault /private/backup/vault \
  --index /private/backup/index.db \
  --config /private/backup/school.config.json \
  --baseline-cli /path/to/old/bin/school.js \
  --candidate-cli /path/to/candidate/bin/school.js
```

Add `--sync --sync-arg --course --sync-arg 12345` to run a targeted sync, and `--keep` to retain successful sandboxes. Failed runs always retain their restricted temporary sandbox and report its location. The runner copies an adjacent `.env` when present (mode 0600); launcher processes read that copied file beside the copied config. Subprocess output is never displayed or saved. SQLite backup uses the online backup API. Index paths beneath the configured original vault are rebased; outside-vault references are replaced with nonexistent quarantine paths inside each sandbox, and only their count is reported. The runner does not follow the original indexed paths to live files.

1. Make a restorable backup of the live vault and index together. Keep it outside the repository with private permissions.
2. Copy that backup twice into private temporary directories. Rebase each copied SQLite `vault_path` from the original vault root to its own sandbox vault root before running a CLI.
3. Give each CLI a private copied config whose `vault.path` and `index.path` point only to its sandbox. Keep the allowlist identical. Verify both `doctor` results.
4. Run the same `sync` command against each sandbox. This reads Canvas and writes only to the sandbox. Compare command exit codes, changed/gap counts, and indexed course IDs.
5. Compare all course files by Canvas identity with `node scripts/parity-compare.mjs BASELINE_VAULT CANDIDATE_VAULT`. The comparator tolerates a change in the outer course-directory name but requires every course file's bytes to match. Investigate every difference before switching the runtime.
6. For generation, use the same requested course and week in both sandboxes. Model wording need not match byte-for-byte. Review actual question coverage, source support, and placement under that week’s `Prep/` folder. Both requests can incur model charges and transmit selected course text to the configured provider.

The file comparator is deliberately strict: it does not ignore prep files, timestamps, or other differences. Run it immediately after equivalent syncs, before the nondeterministic generation check. Keep the sandbox report local; file names can reveal course information.

This check is an acceptance gate, not a claim that every future Canvas state or model response will be identical. A friend testing a fresh install should use their own credentials and must opt in; never use a real person's account as a public fixture.
