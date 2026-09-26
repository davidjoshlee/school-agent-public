import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"

import { runParitySandbox } from "../scripts/parity-sandbox.mjs"

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "school-agent-parity-test-"))
  roots.push(root)
  const vault = join(root, "vault")
  mkdirSync(join(vault, "DEMO"), { recursive: true })
  writeFileSync(join(vault, "DEMO", "_index.md"), '---\ncanvas_id: "101"\n---\n')
  writeFileSync(join(vault, "DEMO", "readme.md"), "synthetic fixture\n")
  const index = join(root, "index.db")
  const db = new Database(index)
  db.exec(
    "CREATE TABLE courses (canvas_id TEXT PRIMARY KEY, vault_path TEXT); CREATE TABLE modules (canvas_id TEXT PRIMARY KEY, vault_path TEXT);",
  )
  db.prepare("INSERT INTO courses VALUES (?, ?)").run("101", join(vault, "DEMO"))
  db.prepare("INSERT INTO modules VALUES (?, ?)").run(
    "external-module",
    join(root, "historic-course"),
  )
  db.close()
  const config = join(root, "school.config.json")
  writeFileSync(join(root, ".env"), "CANVAS_TOKEN=synthetic-private-token\n", { mode: 0o600 })
  writeFileSync(
    config,
    JSON.stringify({
      canvas: { tokenEnv: "CANVAS_TOKEN" },
      vault: { path: vault, gitInit: false },
      index: { path: index },
      courses: { allowlist: ["101"] },
    }),
  )
  const cli = join(root, "fake-cli.mjs")
  writeFileSync(
    cli,
    `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2); const configPath = args[args.indexOf("--config") + 1];
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (args.includes("doctor")) { console.log(process.env.CANVAS_TOKEN); process.exit(0); }
if (args.includes("sync")) { writeFileSync(join(config.vault.path, "synced.md"), "synthetic sync\\n"); console.log(process.env.CANVAS_TOKEN); process.exit(0); }
process.exit(3);
`,
  )
  return { root, vault, index, config, cli }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("private parity sandbox", () => {
  it("runs doctor and opt-in sync only against two copies, then compares them", async () => {
    const f = fixture()
    const backupVault = join(f.root, "backup-vault")
    cpSync(f.vault, backupVault, { recursive: true })
    const result = await runParitySandbox({
      ...f,
      vault: backupVault,
      baseline_cli: f.cli,
      candidate_cli: f.cli,
      sync: true,
      syncArgs: [],
      keep: true,
    })
    expect(result.doctor).toEqual({ baseline: 0, candidate: 0 })
    expect(result.externalIndexReferences).toEqual({ baseline: 1, candidate: 1 })
    expect(result.comparison).toEqual({ equal: true, differenceCount: 0 })
    expect(existsSync(join(f.vault, "synced.md"))).toBe(false)
    const sandbox = result.sandbox as string
    for (const variant of ["baseline", "candidate"]) {
      const copiedConfig = JSON.parse(
        readFileSync(join(sandbox, variant, "school.config.json"), "utf8"),
      )
      expect(copiedConfig.vault.path).toBe(join(sandbox, variant, "vault"))
      expect(readFileSync(join(sandbox, variant, ".env"), "utf8")).toContain(
        "synthetic-private-token",
      )
      expect(statSync(join(sandbox, variant, ".env")).mode & 0o777).toBe(0o600)
      const copiedDb = new Database(copiedConfig.index.path, { readonly: true })
      expect(
        copiedDb.prepare("SELECT vault_path FROM courses WHERE canvas_id = '101'").get(),
      ).toEqual({ vault_path: join(copiedConfig.vault.path, "DEMO") })
      expect(
        copiedDb
          .prepare("SELECT vault_path FROM modules WHERE canvas_id = 'external-module'")
          .get(),
      ).toEqual({
        vault_path: join(copiedConfig.vault.path, "_meta", "parity-external", "modules", "1"),
      })
      copiedDb.close()
      expect(existsSync(join(copiedConfig.vault.path, "synced.md"))).toBe(true)
    }
  })

  it("does not sync without explicit opt-in and retains failed sandboxes", async () => {
    const f = fixture()
    const result = await runParitySandbox({
      ...f,
      baseline_cli: f.cli,
      candidate_cli: f.cli,
      sync: false,
      syncArgs: [],
      keep: true,
    })
    expect(result.sync).toBeNull()
    expect(existsSync(join(f.vault, "synced.md"))).toBe(false)

    const failing = join(f.root, "failing-cli.mjs")
    writeFileSync(failing, "process.exit(1)\n")
    await expect(
      runParitySandbox({
        ...f,
        baseline_cli: failing,
        candidate_cli: f.cli,
        sync: false,
        syncArgs: [],
      }),
    ).rejects.toThrow("Sandbox retained at")
  })
})
