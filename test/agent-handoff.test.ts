import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))

describe("fresh-clone agent handoff", () => {
  it("has a root entry point with resolvable setup and usage references", async () => {
    const guidance = await readFile(resolve(root, "AGENTS.md"), "utf8")
    for (const match of guidance.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]
      if (target === undefined || /^(?:https?:|#)/.test(target)) continue
      await expect(stat(resolve(root, target))).resolves.toBeTruthy()
    }
    for (const command of [
      "npm ci",
      "npm run build",
      "node bin/school.js",
      "setup --canvas-url",
      "doctor",
      "auth verify",
      "courses list --all",
      "sync --course",
      "prep <id> --week",
      "reading-copy --destination",
    ]) {
      expect(guidance).toContain(command)
    }
    expect(guidance).toContain("Never print secrets")
    expect(guidance).toContain("Canvas is GET-only")
    expect(guidance).toContain("Do not install")
  })
})
