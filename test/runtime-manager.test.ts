import { execFileSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"

const project = resolve(fileURLToPath(new URL("..", import.meta.url)))
const script = join(project, "scripts/runtime-manager.mjs")
const tempRoots: string[] = []

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "school-agent-runtime-test-"))
  tempRoots.push(base)
  const candidate = join(base, "candidate")
  mkdirSync(join(candidate, "bin"), { recursive: true })
  cpSync(join(project, "dist"), join(candidate, "dist"), { recursive: true })
  cpSync(join(project, "config"), join(candidate, "config"), { recursive: true })
  cpSync(join(project, "bin/school.js"), join(candidate, "bin/school.js"))
  symlinkSync(join(project, "node_modules"), join(candidate, "node_modules"), "dir")
  writeFileSync(join(candidate, "package.json"), '{"type":"module"}\n')
  const runtimeRoot = join(base, "runtime")
  const vault = join(base, "vault")
  const index = join(base, "index.sqlite")
  mkdirSync(vault)
  writeFileSync(join(vault, "example.md"), "synthetic\n")
  const db = new Database(index)
  db.exec(
    "CREATE TABLE migrations (version INTEGER PRIMARY KEY); INSERT INTO migrations (version) VALUES (0);",
  )
  db.close()
  mkdirSync(join(runtimeRoot, "releases", "old"), { recursive: true })
  symlinkSync(join(runtimeRoot, "releases", "old"), join(runtimeRoot, "current"), "dir")
  return { base, candidate, runtimeRoot, vault, index }
}

function run(args: string[]) {
  execFileSync(process.execPath, [script, ...args], { encoding: "utf8" })
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("runtime manager", () => {
  it("refuses a runtime root nested in the vault before making backup directories", () => {
    const f = fixture()
    const unsafeRoot = join(f.vault, "runtime")
    expect(() =>
      run([
        "upgrade",
        "--root",
        unsafeRoot,
        "--candidate",
        f.candidate,
        "--version",
        "new",
        "--vault",
        f.vault,
        "--index",
        f.index,
      ]),
    ).toThrow("Runtime root and vault must not contain one another")
    expect(existsSync(unsafeRoot)).toBe(false)
  })

  it("checks a disposable migration copy, snapshots state, and switches then rolls back", () => {
    const f = fixture()
    run([
      "upgrade",
      "--root",
      f.runtimeRoot,
      "--candidate",
      f.candidate,
      "--version",
      "new",
      "--vault",
      f.vault,
      "--index",
      f.index,
    ])
    expect(readFileSync(join(f.vault, "example.md"), "utf8")).toBe("synthetic\n")
    expect(existsSync(join(f.runtimeRoot, "backups"))).toBe(true)
    const active = realpathSync(join(f.runtimeRoot, "current"))
    expect(active).toBe(realpathSync(join(f.runtimeRoot, "releases", "new")))
    // The live index was never migrated by the dry-run.
    const liveDb = new Database(f.index, { readonly: true })
    expect(liveDb.prepare("SELECT MAX(version) AS version FROM migrations").get()).toEqual({
      version: 0,
    })
    liveDb.close()
    writeFileSync(join(f.vault, "after-upgrade.md"), "new work\n")
    const backupId = readdirSync(join(f.runtimeRoot, "backups"))[0]
    expect(backupId).toBeDefined()
    expect(() =>
      run([
        "rollback",
        "--root",
        f.runtimeRoot,
        "--vault",
        f.vault,
        "--index",
        join(f.base, "wrong-index.sqlite"),
        "--backup",
        backupId as string,
      ]),
    ).toThrow("Backup vault/index paths do not match")
    run([
      "rollback",
      "--root",
      f.runtimeRoot,
      "--vault",
      f.vault,
      "--index",
      f.index,
      "--backup",
      backupId,
    ])
    expect(realpathSync(join(f.runtimeRoot, "current"))).toBe(
      realpathSync(join(f.runtimeRoot, "releases", "old")),
    )
    expect(existsSync(join(f.vault, "after-upgrade.md"))).toBe(false)
    const recovery = readdirSync(join(f.runtimeRoot, "backups")).find((entry) =>
      entry.startsWith("pre-rollback-"),
    )
    expect(recovery).toBeDefined()
    expect(
      readFileSync(
        join(f.runtimeRoot, "backups", recovery as string, "vault", "after-upgrade.md"),
        "utf8",
      ),
    ).toBe("new work\n")
    const displaced = readdirSync(f.base).find((entry) => entry.startsWith("vault.pre-rollback-"))
    expect(displaced).toBeDefined()
    expect(readFileSync(join(f.base, displaced as string, "after-upgrade.md"), "utf8")).toBe(
      "new work\n",
    )
  })
})
