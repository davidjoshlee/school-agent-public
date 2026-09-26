#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
import { dirname, join, parse, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

const help = `Usage:
  node scripts/runtime-manager.mjs upgrade --root DIR --candidate DIR --version VERSION --vault DIR --index FILE
  node scripts/runtime-manager.mjs rollback --root DIR --vault DIR --index FILE --backup ID

The candidate must be a built School Agent runtime directory containing bin/school.js,
dist/store/db-schema.js, and node_modules/better-sqlite3. Runtime releases live under
DIR/releases; DIR/current is switched atomically. Backups are retained under DIR/backups.`

function argumentsMap(args) {
  const result = new Map()
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i]
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`)
    const value = args[i + 1]
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
    if (result.has(key)) throw new Error(`Duplicate option: ${key}`)
    result.set(key, value)
    i += 1
  }
  return result
}

function required(options, key) {
  const value = options.get(key)
  if (!value) throw new Error(`Missing required option ${key}`)
  return value
}

function safeId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value))
    throw new Error(`Unsafe identifier: ${value}`)
  return value
}

function inside(parent, child) {
  const path = relative(parent, child)
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep))
}

function assertSafeLocations(root, vault, index) {
  if (vault === parse(vault).root || vault === homedir())
    throw new Error("Vault must be a specific directory, not a filesystem or home root.")
  if (root === parse(root).root || root === homedir())
    throw new Error("Runtime root must be a specific directory, not a filesystem or home root.")
  if (inside(root, vault) || inside(vault, root))
    throw new Error("Runtime root and vault must not contain one another.")
  if (inside(vault, index)) throw new Error("SQLite index must be outside the vault tree.")
}

function run(executable, args, cwd, env = process.env) {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", stdio: "pipe" })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${executable} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`)
}

function acquireLock(root) {
  const lockPath = join(root, ".upgrade-lock")
  try {
    mkdirSync(lockPath)
  } catch (error) {
    if (error?.code === "EEXIST")
      throw new Error(`Another upgrade/rollback may be running (lock: ${lockPath}).`)
    throw error
  }
  writeFileSync(join(lockPath, "owner"), `${process.pid}\n`, { flag: "wx" })
  return () => rmSync(lockPath, { recursive: true })
}

async function copyDatabase(source, destination, runtime) {
  if (!existsSync(source)) return false
  const require = createRequire(join(runtime, "package.json"))
  const Database = require("better-sqlite3")
  const db = new Database(source, { readonly: true, fileMustExist: true })
  try {
    await db.backup(destination)
  } finally {
    db.close()
  }
  return true
}

function dbMigrationVersion(db) {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migrations'")
    .get()
  if (!table) return 0
  return db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM migrations").get().version
}

async function migrationDryRun(candidate, dbPath) {
  if (!existsSync(dbPath)) return { before: 0, after: 0, checked: false }
  const require = createRequire(join(candidate, "package.json"))
  const Database = require("better-sqlite3")
  const schemaModule = await import(pathToFileURL(join(candidate, "dist/store/db-schema.js")))
  if (typeof schemaModule.migrateIndex !== "function")
    throw new Error("Candidate does not export migrateIndex")
  const db = new Database(dbPath)
  try {
    db.pragma("journal_mode = DELETE")
    const before = dbMigrationVersion(db)
    schemaModule.migrateIndex(db)
    const after = dbMigrationVersion(db)
    const check = db.pragma("quick_check", { simple: true })
    if (check !== "ok") throw new Error(`SQLite integrity check failed: ${check}`)
    return { before, after, checked: true }
  } finally {
    db.close()
  }
}

function atomicCurrent(root, target) {
  const temp = join(root, `.current-${process.pid}-${Date.now()}`)
  symlinkSync(target, temp, "dir")
  try {
    renameSync(temp, join(root, "current"))
  } finally {
    if (existsSync(temp)) rmSync(temp)
  }
}

function currentTarget(root) {
  const path = join(root, "current")
  try {
    if (!lstatSync(path).isSymbolicLink())
      throw new Error("Runtime pointer is not a symlink; refusing to replace it.")
    return realpathSync(path)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function makeBackup({ root, vault, index, runtime, id, previous }) {
  const backupRoot = join(root, "backups", id)
  mkdirSync(backupRoot, { recursive: false, mode: 0o700 })
  try {
    if (existsSync(vault))
      cpSync(vault, join(backupRoot, "vault"), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
      })
    const indexPresent = await copyDatabase(index, join(backupRoot, "index.sqlite"), runtime)
    writeFileSync(
      join(backupRoot, "metadata.json"),
      `${JSON.stringify({ id, previous, vault: resolve(vault), index: resolve(index), vaultPresent: existsSync(join(backupRoot, "vault")), indexPresent }, null, 2)}\n`,
      { flag: "wx" },
    )
  } catch (error) {
    rmSync(backupRoot, { recursive: true, force: true })
    throw error
  }
  return backupRoot
}

async function upgrade(options) {
  const root = resolve(required(options, "--root"))
  const candidate = realpathSync(required(options, "--candidate"))
  const version = safeId(required(options, "--version"))
  const vault = resolve(required(options, "--vault"))
  const index = resolve(required(options, "--index"))
  assertSafeLocations(root, vault, index)
  if (
    !existsSync(join(candidate, "bin/school.js")) ||
    !existsSync(join(candidate, "dist/store/db-schema.js"))
  ) {
    throw new Error("Candidate is missing the launcher or database migration module.")
  }
  for (const unsafe of [".git", ".env", ".env.local", "school.config.json"]) {
    if (existsSync(join(candidate, unsafe)))
      throw new Error(
        `Candidate contains user or repository state (${unsafe}); stage a clean runtime artifact.`,
      )
  }
  mkdirSync(join(root, "releases"), { recursive: true })
  mkdirSync(join(root, "backups"), { recursive: true })
  const unlock = acquireLock(root)
  try {
    const target = join(root, "releases", version)
    if (existsSync(target)) throw new Error(`Release already exists: ${target}`)
    const previous = currentTarget(root)
    // The migration and smoke checks run against a disposable copy before touching the live pointer.
    const scratch = mkdtempSync(join(tmpdir(), "school-agent-upgrade-check-"))
    let migration
    try {
      const scratchIndex = join(scratch, "index.sqlite")
      if (existsSync(index)) await copyDatabase(index, scratchIndex, candidate)
      migration = await migrationDryRun(candidate, scratchIndex)
      run(process.execPath, [join(candidate, "bin/school.js"), "--help"], candidate)
      const scratchHome = join(scratch, "home")
      const scratchConfig = join(scratch, "config", "school.config.json")
      mkdirSync(dirname(scratchConfig), { recursive: true })
      mkdirSync(scratchHome, { recursive: true })
      const smokeEnv = {
        ...process.env,
        HOME: scratchHome,
        USERPROFILE: scratchHome,
        CANVAS_TOKEN: "synthetic-smoke-token",
      }
      run(
        process.execPath,
        [
          join(candidate, "bin/school.js"),
          "--config",
          scratchConfig,
          "setup",
          "--canvas-url",
          "https://canvas.example.test",
        ],
        candidate,
        smokeEnv,
      )
      run(
        process.execPath,
        [join(candidate, "bin/school.js"), "--config", scratchConfig, "doctor", "--sync-only"],
        candidate,
        smokeEnv,
      )
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
    const id = `${new Date().toISOString().replaceAll(":", "-")}-${version}`
    await makeBackup({ root, vault, index, runtime: candidate, id, previous })
    // Copy the candidate into its immutable release directory before switching the pointer.
    cpSync(candidate, target, { recursive: true, dereference: true, errorOnExist: true })
    try {
      atomicCurrent(root, target)
    } catch (error) {
      rmSync(target, { recursive: true, force: true })
      throw error
    }
    console.log(JSON.stringify({ status: "upgraded", version, backup: id, migration }, null, 2))
  } finally {
    unlock()
  }
}

async function restoreDatabase(backupFile, liveFile, runtime) {
  if (!existsSync(backupFile)) {
    if (existsSync(liveFile)) rmSync(liveFile)
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(`${liveFile}${suffix}`)) rmSync(`${liveFile}${suffix}`)
    return
  }
  const require = createRequire(join(runtime, "package.json"))
  const Database = require("better-sqlite3")
  const source = new Database(backupFile, { readonly: true, fileMustExist: true })
  try {
    const staged = `${liveFile}.restore-${process.pid}`
    await source.backup(staged)
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(`${liveFile}${suffix}`)) rmSync(`${liveFile}${suffix}`)
    renameSync(staged, liveFile)
  } finally {
    source.close()
  }
}

async function rollback(options) {
  const root = resolve(required(options, "--root"))
  const vault = resolve(required(options, "--vault"))
  const index = resolve(required(options, "--index"))
  assertSafeLocations(root, vault, index)
  const id = safeId(required(options, "--backup"))
  const backupRoot = join(root, "backups", id)
  const metadata = JSON.parse(readFileSync(join(backupRoot, "metadata.json"), "utf8"))
  if (metadata.vault !== vault || metadata.index !== index)
    throw new Error(
      "Backup vault/index paths do not match the requested targets; refusing rollback.",
    )
  const unlock = acquireLock(root)
  try {
    const current = currentTarget(root)
    if (!current)
      throw new Error(
        "No active runtime pointer; refusing rollback without a runtime for consistent SQLite recovery.",
      )
    const recoveryId = `pre-rollback-${new Date().toISOString().replaceAll(":", "-")}-${id}`
    await makeBackup({ root, vault, index, runtime: current, id: recoveryId, previous: current })
    if (metadata.vaultPresent) {
      if (!existsSync(join(backupRoot, "vault")))
        throw new Error("Backup vault is missing; refusing partial rollback.")
      const replacement = `${vault}.rollback-${process.pid}`
      if (existsSync(replacement))
        throw new Error(`Rollback staging path already exists: ${replacement}`)
      cpSync(join(backupRoot, "vault"), replacement, { recursive: true, errorOnExist: true })
      const saved = `${vault}.pre-rollback-${process.pid}`
      if (existsSync(vault)) renameSync(vault, saved)
      try {
        renameSync(replacement, vault)
        // Keep the displaced live tree as an additional direct recovery copy.
      } catch (error) {
        if (existsSync(saved) && !existsSync(vault)) renameSync(saved, vault)
        throw error
      }
    }
    if (current) await restoreDatabase(join(backupRoot, "index.sqlite"), index, current)
    else if (existsSync(join(backupRoot, "index.sqlite")))
      throw new Error("Cannot restore index without an active runtime for SQLite backup support.")
    if (metadata.previous) atomicCurrent(root, metadata.previous)
    else {
      const pointer = join(root, "current")
      if (existsSync(pointer)) rmSync(pointer)
    }
    console.log(
      JSON.stringify({ status: "rolled-back", backup: id, previous: metadata.previous }, null, 2),
    )
  } finally {
    unlock()
  }
}

async function main() {
  const [action, ...args] = process.argv.slice(2)
  if (action === "--help" || action === "-h" || action === undefined) {
    console.log(help)
    return
  }
  const options = argumentsMap(args)
  if (action === "upgrade") return upgrade(options)
  if (action === "rollback") return rollback(options)
  throw new Error(`Unknown action: ${action}\n\n${help}`)
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export { argumentsMap, migrationDryRun }
