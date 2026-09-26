# Pinned runtime upgrades

The release maintainer runtime layout uses an immutable `releases/<version>` directory and a `current` symlink. Build and stage the candidate runtime separately; do not build in the active release directory. Keep the user's application stopped while upgrading or rolling back so SQLite and vault writers cannot race the snapshot. The manager does not update an existing `sa` shell function, alias, npm global install, or launcher path. Adopting this layout requires a one-time user-controlled change so `sa` invokes `root/current/bin/school.js`; until then, the existing `sa` continues to use its existing pinned runtime.

From a built checkout, run:

```sh
node scripts/runtime-manager.mjs upgrade \
  --root /path/to/school-agent-runtime \
  --candidate /path/to/staged/school-agent-runtime \
  --version 1.2.3 \
  --vault /path/to/vault \
  --index /path/to/school-agent.sqlite
```

Before switching `current`, the manager creates a disposable SQLite backup and asks the candidate's `migrateIndex` to migrate that copy, runs SQLite `quick_check`, launches `school --help`, then runs synthetic `setup` and `doctor --sync-only` with temporary home/config paths and a dummy Canvas token. These checks do not contact Canvas or an AI provider. It then snapshots the vault and SQLite index under `root/backups/<id>`, copies the candidate into `root/releases/<version>`, and atomically replaces the `current` symlink. It prints the backup ID; retain it with release notes.

Rollback using that ID:

```sh
node scripts/runtime-manager.mjs rollback \
  --root /path/to/school-agent-runtime \
  --vault /path/to/vault \
  --index /path/to/school-agent.sqlite \
  --backup <printed-backup-id>
```

Rollback first creates a `pre-rollback-*` recovery backup of the current vault and SQLite index, then restores the selected vault and SQLite snapshot and points `current` to the runtime that was active at backup time. That recovery backup preserves work created since the upgrade. The displaced vault tree is also retained beside the vault as `<vault>.pre-rollback-<pid>`; inspect it before removing it. The selected backup records the original vault and index paths, and rollback refuses if the requested paths do not match. Backup directories are created with mode `0700`. Backups are retained; remove them only under the site's normal retention policy. The manager serializes its own operations with a lock directory. This lock cannot stop School Agent or other processes from writing, so stop them before running either action.

This script manages a pinned runtime directory and does not install Node.js or alter shell configuration. Its test uses only temporary synthetic vault and index data.
