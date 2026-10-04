import { execFile } from "node:child_process"
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

import { hasErrorCode } from "../util/errors.js"
import { vaultLayout } from "./paths.js"

export type ObsidianVaultPlan = {
  readonly root: string
  readonly guidePath: string
  readonly uri: string
  readonly fileTypes: Readonly<Record<string, number>>
  readonly blockers: readonly string[]
  readonly warnings: readonly string[]
  readonly courseHomes: readonly string[]
}

/** Inspect names and filesystem metadata only; never read credential or coursework contents. */
export async function planObsidianVault(input: {
  readonly root: string
  readonly privatePaths: readonly string[]
}): Promise<ObsidianVaultPlan> {
  const root = resolve(input.root)
  const canonicalRoot = await canonicalPath(root)
  const blockers: string[] = []
  const warnings: string[] = []
  const fileTypes: Record<string, number> = {}
  const courseHomes: string[] = []
  for (const path of input.privatePaths) {
    if (inside(await canonicalPath(resolve(path)), canonicalRoot)) {
      blockers.push("Configured credentials, configuration, or index path is inside the vault.")
    }
  }
  const inspect = async (directory: string): Promise<void> => {
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") && directory === root) return
      throw error
    }
    for (const name of entries.sort()) {
      const path = join(directory, name)
      const local = relative(root, path)
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        blockers.push(`Symlink requires review before syncing: ${local}`)
        continue
      }
      if (name === vaultLayout.obsidianGuide && directory === root && !info.isFile()) {
        blockers.push("The getting-started note path is not a regular file.")
        continue
      }
      if (name === ".agent-runs") {
        warnings.push(
          `Keep ${local} local: Obsidian Sync excludes hidden folders; explicitly exclude it with any other sync provider. Do not move it while existing drafts depend on it.`,
        )
        continue
      }
      if (name === ".obsidian" && !info.isDirectory()) {
        blockers.push(`Obsidian settings path is not a directory: ${local}`)
        continue
      }
      if (
        /^(?:\.env(?:\..*)?|school\.config\.json)$|\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(
          name,
        )
      ) {
        blockers.push(`Private configuration or database must stay outside the vault: ${local}`)
        continue
      }
      if (name === ".obsidian" || name === ".git") continue
      if (info.isDirectory()) {
        if (name === vaultLayout.metadata) {
          warnings.push(
            `Exclude ${local} from Sync on every device; it contains operational state and potentially private model context.`,
          )
        }
        await inspect(path)
      } else if (info.isFile()) {
        const extension = extname(name).toLowerCase() || "(no extension)"
        fileTypes[extension] = (fileTypes[extension] ?? 0) + 1
        if (extension === vaultLayout.iCloudStub)
          warnings.push(`Undownloaded placeholder: ${local}`)
        if (
          name === vaultLayout.home &&
          relative(root, directory).split(sep).length === 1 &&
          directory !== root
        ) {
          courseHomes.push(local)
        }
      }
    }
  }
  await inspect(root)
  const guidePath = join(root, vaultLayout.obsidianGuide)
  return {
    root,
    guidePath,
    uri: `obsidian://open?path=${encodeURIComponent(guidePath)}`,
    fileTypes,
    blockers: [...new Set(blockers)],
    warnings,
    courseHomes,
  }
}

/** Reinspect before writing, create exclusively, and preserve every existing user file. */
export async function prepareObsidianVault(input: {
  readonly root: string
  readonly privatePaths: readonly string[]
}): Promise<{ readonly plan: ObsidianVaultPlan; readonly created: boolean }> {
  const plan = await planObsidianVault(input)
  if (plan.blockers.length > 0)
    throw new Error(
      "Obsidian preparation blocked; resolve the reported private paths or symlinks first.",
    )
  await mkdir(plan.root, { recursive: true })
  try {
    await writeFile(plan.guidePath, renderGuide(plan), { encoding: "utf8", flag: "wx" })
    return { plan, created: true }
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return { plan, created: false }
    throw error
  }
}

export function obsidianLaunchCommand(
  uri: string,
  platform = process.platform,
): {
  readonly command: string
  readonly args: readonly string[]
} {
  if (!uri.startsWith("obsidian://open?path=")) throw new Error("Expected an Obsidian open URI.")
  if (platform === "darwin") return { command: "open", args: [uri] }
  if (platform === "linux") return { command: "xdg-open", args: [uri] }
  throw new Error(
    "Automatic Obsidian opening is supported on macOS and Linux only; use the printed URI manually.",
  )
}

export async function openObsidianVault(uri: string): Promise<void> {
  const launch = obsidianLaunchCommand(uri)
  try {
    await promisify(execFile)(launch.command, launch.args, { timeout: 10_000 })
  } catch {
    throw new Error(
      "Could not launch Obsidian. Install and launch the app, then use Open folder as vault for the printed path. No files were moved.",
    )
  }
}

function inside(path: string, root: string): boolean {
  const local = relative(root, path)
  return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local))
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error
    const parent = dirname(path)
    if (parent === path) return path
    return join(await canonicalPath(parent), relative(parent, path))
  }
}

function renderGuide(plan: ObsidianVaultPlan): string {
  const links = plan.courseHomes
    .map((path) => {
      const label = dirname(path)
        .replace(/[\r\n]/g, " ")
        .replace(/[[\]\\]/g, "\\$&")
      const target = path
        .split(sep)
        .map((part) =>
          encodeURIComponent(part).replace(
            /[!'()*]/g,
            (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
          ),
        )
        .join("/")
      return `- [${label}](${target})`
    })
    .join("\n")
  return `---\nsource: user\n---\n# School Agent vault\n\nThese are your original local files, not an import or a replacement for Finder. This guide is created once and never overwritten; course links below are a setup-time snapshot you can edit.\n\n## Courses\n\n${links || "Run School Agent sync on your primary computer, then browse the course folders."}\n\n## Files and editing\n\nMarkdown briefs, notes, and drafts can be read in Obsidian. PDFs, images, and supported media can be viewed there. Office documents and other originals remain on disk; open unsupported formats in their normal apps through Finder or your file manager. Obsidian may hide unsupported formats from its file browser. No originals are converted or removed by this command.\n\nKeep personal annotations in separate notes or user guidance: generated prep can be refreshed by School Agent. File synchronization does not coordinate simultaneous agent writers. Run sync, prep, draft, revise, and approve on one primary computer only.\n\n## Cross-device setup\n\n1. In Obsidian, choose **Open folder as vault** and select this folder. No plugins are required.\n2. Before enabling Obsidian Sync, exclude **${vaultLayout.metadata}** on every device. Keep credentials, school.config.json, and live SQLite databases outside the vault. Obsidian Sync automatically excludes hidden .agent-runs folders; keep those records local and explicitly exclude them if using any other sync provider. This check is not a complete secret/content audit. Review course-material sharing rules before uploading.\n3. Connect a private remote vault with end-to-end encryption in Obsidian. This command does not create an account, buy a plan, configure Sync, or upload files.\n4. Enable PDFs/images and **Sync all other types** if you want Office originals copied too. Check your plan's file-size and storage limits. Configure selective sync separately on each device.\n5. Connect Obsidian on your phone or second computer and wait for downloads to finish before editing. Avoid editing the same note on two offline devices; review conflict copies.\n6. Keep a separate backup. Sync propagates deletions and is not a substitute for backup. Do not combine Obsidian Sync with another folder-sync provider. School Agent still refuses iCloud-backed vault paths.\n\nObsidian does not run the CLI or fetch Canvas updates. The primary computer must run School Agent; remote execution is a separate feature.\n\n[Sync settings](https://obsidian.md/help/sync/settings) · [Supported formats](https://obsidian.md/help/file-formats)\n`
}
