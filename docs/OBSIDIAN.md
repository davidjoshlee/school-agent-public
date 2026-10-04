# Open your School Agent vault in Obsidian

Obsidian is an optional reader/editor over the existing local vault. Finder and School Agent keep using the same folder. This integration does not move files, convert originals, change your configuration, install plugins, register a cloud account, or upload anything.

## Prepare and open

```bash
school-agent vault obsidian
school-agent vault obsidian --apply
```

The first command is a read-only preview: it reports file extensions and checks for known private configuration/database paths and symlinks. It exits unsuccessfully if those require review. These checks inspect filenames and filesystem metadata, not file contents; they are not a complete security audit. Fix the reported locations yourself before preparing a synced vault. The command never moves or deletes them for you.

`--apply` creates `00 School Agent.md`, a getting-started note with links to currently available course home pages. Existing notes and Obsidian settings are never overwritten. Course links are a setup-time snapshot you can edit; new courses still appear in the folder tree. An empty vault can be prepared before the first Canvas sync.

Install and launch Obsidian, choose **Open folder as vault**, and select the exact path printed by the command. This manual registration is required the first time. Afterwards:

```bash
school-agent vault obsidian --open
```

`--open` sends a correctly encoded Obsidian URI through the macOS/Linux desktop launcher. It requires the guide to exist, and does not verify that Obsidian selected the intended vault. Verify that in the app. On a headless machine, use the printed URI on a desktop with that vault registered instead. You can combine `--apply --open` after registration. No Canvas or model calls are made.

## Different file types

Markdown can be read and edited in Obsidian. Supported PDFs, images, audio, and video can be viewed within the app. Office documents and other originals remain on disk; use Finder or your normal file manager to open unsupported types in their native apps. They may not appear in Obsidian's file browser. This integration does not add an Office viewer or change School Agent's ingest behavior.

See [Obsidian's accepted formats](https://obsidian.md/help/file-formats).

## Cross-device sync

Choose a sync provider deliberately; this feature does not configure one for you. For Obsidian Sync:

1. Keep the vault in its current local folder. Do not also place it under another folder-sync provider. School Agent's existing iCloud-path restriction remains in effect.
2. Before connecting, review course-material sharing rules. Choose a private remote vault with end-to-end encryption in Obsidian; hosting files is a separate disclosure from model generation.
3. Exclude every `_meta` folder reported by the preview on **every device**: they contain operational state and potentially private source/model context. Keep `school.config.json`, adjacent `.env`, and SQLite databases (including WAL/SHM) outside the vault. School Agent stores durable draft/run state in hidden `.agent-runs` folders; Obsidian Sync excludes hidden folders automatically, so leave those records in place. Other sync providers must explicitly exclude them. Do not move records that existing drafts depend on.
4. Enable the attachment types you need. For Office files, enable **Sync all other types**. Check current file-size/storage limits before purchasing a plan or expecting large readings to sync. Selective-sync settings are device-specific.
5. Connect the mobile or second-computer Obsidian app to the same remote vault. Wait for complete downloads before editing; configure conflict handling and review conflicts rather than assuming automatic merges are correct.
6. Keep a separate backup: synchronized deletion can affect every device. Exclusions do not remove files already uploaded; review the remote vault if exclusions were added later.

Use [official setup guidance](https://obsidian.md/help/sync-notes) and [selective-sync settings](https://obsidian.md/help/sync/settings) for current settings and limits.

## Google Drive without Obsidian Sync

For read-only iPhone access, use the Google Drive app instead of Obsidian mobile. Leave the working vault local and export to a private folder under your chosen account's My Drive:

```bash
school-agent vault reading-copy --destination "/path/to/Google Drive/My Drive/School Agent Reading"
school-agent vault reading-copy --destination "/path/to/Google Drive/My Drive/School Agent Reading" --apply
```

Each export makes a new dated snapshot. It never replaces earlier snapshots, propagates deletes, updates the source, or refreshes automatically. Run it again after new prep/sync work; the primary computer and Drive client must be online to upload. Old snapshots remain until you deliberately remove them.

For a persistent reading copy, add `--current --apply`. This saves the destination mapping and file ownership in local `_meta/reading-mirror.json`. Only changed files are rewritten. Replaced files, unexpected edits to owned Drive files, and copies removed from the source move to `Recovered` under the destination, so they remain recoverable. Source files and previous dated snapshots are never changed. Unexpected/unowned files at an intended output path block refresh, as do symlinks. A changed destination is refused rather than silently rerouting uploads.

Once an applied `Current` export saves the mapping, successful `sync`, `ingest`, `prep`, `draft` (not discussion-only), `revise`, `approve`, and `homework --draft` commands automatically refresh it. Other commands do not upload. A refresh failure warns without marking already-saved local work as failed. Finder/Obsidian edits still require a manual refresh or a separately verified scheduler.

You can schedule the refresh command with the operating system without making Canvas/model calls, but verify a changed-file pass, not just an unchanged-file check: cloud-provider filesystem operations may stall in background jobs on some Macs. Do not leave a stalled scheduler enabled. Scheduled checks run only while logged in and awake; uploads additionally require Drive for desktop and connectivity. This is polling, not an instantaneous or transactional distributed sync. The command prints changed/unchanged/recovered counts; failures exit nonzero for the scheduler's error log. A crashed process can leave the local `_meta/reading-mirror.lock` directory: verify no refresh is running before removing that empty lock and retrying. A partial refresh fails closed; unowned output files may need manual recovery before retrying.

Markdown is exported as `.md.txt` for Drive text preview, with frontmatter removed and known signed-link query values redacted. Formatting remains plain text, not a rendered Obsidian page; links to other Markdown files are not rewritten. PDFs, images, media, and Office originals retain their formats. No native Google Docs/Sheets conversion is performed.

Only allowlisted reading formats are exported. Hidden files/folders, `_meta` at every level, `_index.md`, simulations, old archives, databases, JSON state, and the Obsidian-only guide are excluded. Symlinks are not followed. This is not a complete content/secret audit. Copies of course materials are transmitted to your selected Google account: review course rules and keep the destination private. This does not give Google Drive end-to-end encryption or make the CLI remotely accessible.

On iPhone, sign into that same account in Google Drive, open **My Drive → School Agent Reading → Current** for persistent mode, or the **newest Reading folder** for snapshots, and start with `00 READ ME.txt`. Mark desired files available offline in the phone app. Files on Drive are intended as a reading copy, not technically write-protected against their owner.

## One primary agent computer

Other devices can read the vault and edit personal notes. Run School Agent sync/generation/revision/approval on one primary computer only. Folder sync does not provide a distributed write lock, shared spending ledger, or remote CLI. SQLite and durable agent state stay on that computer.

Generated prep may be refreshed by later runs. Put personal annotations in separate notes or user guidance rather than editing generated prep in place. Existing guidance and draft ownership behavior is unchanged. Remote execution while the primary computer is closed is a separate, not-yet-implemented feature.
