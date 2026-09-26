#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
// Private, opt-in runtime parity runner. All CLI invocations target copies in a
// mode-0700 temporary directory; subprocess output is intentionally suppressed.
import Database from "better-sqlite3"

function parseArguments(arguments_) {
  const options = { syncArgs: [] }
  for (let index = 0; index < arguments_.length; index += 1) {
    const key = arguments_[index]
    if (key === "--sync") options.sync = true
    else if (key === "--keep") options.keep = true
    else if (key === "--sync-arg") options.syncArgs.push(arguments_[++index])
    else if (
      ["--vault", "--index", "--config", "--baseline-cli", "--candidate-cli"].includes(key)
    ) {
      options[key.slice(2).replaceAll("-", "_")] = arguments_[++index]
    } else throw new Error(`Unknown option: ${key}`)
  }
  const required = ["vault", "index", "config", "baseline_cli", "candidate_cli"]
  const missing = required.filter((key) => !options[key])
  if (missing.length)
    throw new Error(
      `Missing required options: ${missing.map((key) => `--${key.replaceAll("_", "-")}`).join(", ")}`,
    )
  if (options.syncArgs.some((argument) => typeof argument !== "string")) {
    throw new Error("Each --sync-arg requires a value")
  }
  return options
}

function rejectSymlinks(root) {
  const metadata = lstatSync(root)
  if (metadata.isSymbolicLink()) throw new Error(`Input must not be a symlink: ${basename(root)}`)
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(root)) rejectSymlinks(join(root, entry))
  }
}

function copyTree(source, destination) {
  rejectSymlinks(source)
  cpSync(source, destination, { recursive: true, force: false, errorOnExist: true })
}

function rebaseIndex(indexPath, originalVault, copiedVault) {
  const db = new Database(indexPath)
  let externalReferences = 0
  try {
    const tables = ["courses", "modules", "assignments", "announcements", "files"]
    const knownTables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    )
    for (const table of tables) {
      if (!knownTables.has(table)) continue
      const columns = db.prepare(`PRAGMA table_info(${table})`).all()
      if (!columns.some((column) => column.name === "vault_path")) continue
      const rows = db
        .prepare(`SELECT rowid, vault_path FROM ${table} WHERE vault_path IS NOT NULL`)
        .all()
      const update = db.prepare(`UPDATE ${table} SET vault_path = ? WHERE rowid = ?`)
      db.transaction(() => {
        for (const row of rows) {
          const oldPath = resolve(row.vault_path)
          const rel = relativePath(originalVault, oldPath)
          if (rel === null) {
            externalReferences += 1
            // Quarantine stale external references; a copied index must never
            // direct either CLI to the original live filesystem.
            update.run(
              join(copiedVault, "_meta", "parity-external", table, String(row.rowid)),
              row.rowid,
            )
            continue
          }
          update.run(join(copiedVault, rel), row.rowid)
        }
      })()
    }
  } finally {
    db.close()
  }
  return externalReferences
}

function relativePath(root, path) {
  if (!isAbsolute(path)) return null
  const rel = relative(root, path)
  if (path !== root && (rel === path || rel.startsWith("..") || isAbsolute(rel))) return null
  return rel
}

function secureTree(root) {
  chmodSync(root, 0o700)
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) secureTree(path)
    else if (entry.isFile()) chmodSync(path, 0o600)
  }
}

function runCli(script, config, extraArguments = []) {
  // Keep potentially sensitive stdout/stderr in memory only; never print or persist it.
  const result = spawnSync(
    process.execPath,
    [resolve(script), "--config", config, ...extraArguments],
    {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  if (result.error) return { exitCode: null, ok: false }
  return { exitCode: result.status, ok: result.status === 0 }
}

async function setupSandbox(root, name, inputs) {
  const sandbox = join(root, name)
  const vault = join(sandbox, "vault")
  const index = join(sandbox, "index.db")
  const config = join(sandbox, "school.config.json")
  const environment = join(sandbox, ".env")
  const configuration = JSON.parse(readFileSync(inputs.config, "utf8"))
  if (!configuration.vault || !configuration.index || typeof configuration.vault.path !== "string")
    throw new Error("Config must define vault and index paths")
  const originalVault = expandHome(configuration.vault.path)
  if (!isAbsolute(originalVault)) throw new Error("Config vault path must be absolute")
  mkdirSync(sandbox, { mode: 0o700 })
  copyTree(inputs.vault, vault)
  rejectSymlinks(inputs.index)
  const sourceIndex = new Database(inputs.index, { readonly: true, fileMustExist: true })
  try {
    await sourceIndex.backup(index)
  } finally {
    sourceIndex.close()
  }
  const externalIndexReferences = rebaseIndex(index, originalVault, vault)
  configuration.vault.path = vault
  configuration.index.path = index
  writeFileSync(config, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600, flag: "wx" })
  let copiedEnvironment
  const suppliedEnvironment = join(dirname(resolve(inputs.config)), ".env")
  if (existsSync(suppliedEnvironment)) {
    rejectSymlinks(suppliedEnvironment)
    if (!lstatSync(suppliedEnvironment).isFile())
      throw new Error("Adjacent .env must be a regular file")
    cpSync(suppliedEnvironment, environment, { errorOnExist: true })
    chmodSync(environment, 0o600)
    copiedEnvironment = environment
  }
  secureTree(sandbox)
  return { vault, config, environment: copiedEnvironment, externalIndexReferences }
}

function expandHome(path) {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : resolve(path)
}

export async function runParitySandbox(options) {
  const root = mkdtempSync(join(tmpdir(), "school-agent-parity-"))
  chmodSync(root, 0o700)
  let completed = false
  try {
    for (const input of [
      options.vault,
      options.index,
      options.config,
      options.baseline_cli,
      options.candidate_cli,
    ]) {
      if (!existsSync(input)) throw new Error("One or more supplied input paths do not exist")
    }
    if (
      !lstatSync(options.vault).isDirectory() ||
      !lstatSync(options.index).isFile() ||
      !lstatSync(options.config).isFile()
    ) {
      throw new Error("Vault, index, or config input has the wrong file type")
    }
    const baseline = await setupSandbox(root, "baseline", options)
    const candidate = await setupSandbox(root, "candidate", options)
    const baselineDoctor = runCli(options.baseline_cli, baseline.config, ["doctor"])
    const candidateDoctor = runCli(options.candidate_cli, candidate.config, ["doctor"])
    if (!baselineDoctor.ok || !candidateDoctor.ok) {
      throw new Error("Doctor failed in one or both sandboxes; sandbox retained for debugging")
    }
    let sync = null
    let comparison = null
    if (options.sync) {
      const baselineSync = runCli(options.baseline_cli, baseline.config, [
        "sync",
        ...options.syncArgs,
      ])
      const candidateSync = runCli(options.candidate_cli, candidate.config, [
        "sync",
        ...options.syncArgs,
      ])
      sync = { baselineExitCode: baselineSync.exitCode, candidateExitCode: candidateSync.exitCode }
      if (!baselineSync.ok || !candidateSync.ok) {
        throw new Error("Sync failed in one or both sandboxes; sandbox retained for debugging")
      }
      const comparator = join(dirname(fileURLToPath(import.meta.url)), "parity-compare.mjs")
      const compared = spawnSync(process.execPath, [comparator, baseline.vault, candidate.vault], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      })
      if (compared.error || compared.status === null)
        throw new Error("Vault comparison could not run; sandbox retained")
      let parsed
      try {
        parsed = JSON.parse(compared.stdout)
      } catch {
        throw new Error("Vault comparison returned an invalid report; sandbox retained")
      }
      comparison = {
        equal: parsed.equal === true,
        differenceCount: Array.isArray(parsed.differences) ? parsed.differences.length : null,
      }
    }
    completed = true
    return {
      doctor: { baseline: baselineDoctor.exitCode, candidate: candidateDoctor.exitCode },
      externalIndexReferences: {
        baseline: baseline.externalIndexReferences,
        candidate: candidate.externalIndexReferences,
      },
      sync,
      comparison,
      sandbox: options.keep ? root : undefined,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Parity sandbox failed"
    throw new Error(`${message}. Sandbox retained at ${root}`)
  } finally {
    if (completed && !options.keep) rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  try {
    const result = await runParitySandbox(parseArguments(process.argv.slice(2)))
    console.log(JSON.stringify(result, null, 2))
    if (result.comparison && !result.comparison.equal) process.exitCode = 1
  } catch (error) {
    // Deliberately omit underlying subprocess output and input paths.
    console.error(error instanceof Error ? error.message : "Parity sandbox failed")
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main()
