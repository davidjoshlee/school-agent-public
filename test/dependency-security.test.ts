import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

interface Lockfile {
  packages: Record<string, { version?: string }>
}

function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10))
}

function isAtLeast(version: string, minimum: string): boolean {
  const actual = versionParts(version)
  const expected = versionParts(minimum)

  for (let index = 0; index < expected.length; index += 1) {
    const difference = (actual[index] ?? 0) - (expected[index] ?? 0)
    if (difference !== 0) return difference > 0
  }

  return true
}

describe("production dependency security", () => {
  it("locks every undici copy at a version fixed for the 2026 high severity advisories", () => {
    const lockfile = JSON.parse(
      readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
    ) as Lockfile
    const undiciPackages = Object.entries(lockfile.packages).filter(
      ([path]) => path === "node_modules/undici" || path.endsWith("/node_modules/undici"),
    )

    expect(undiciPackages.length).toBeGreaterThan(0)
    for (const [path, dependency] of undiciPackages) {
      expect(dependency.version, path).toBeDefined()
      expect(isAtLeast(dependency.version ?? "0.0.0", "7.29.1"), path).toBe(true)
    }
  })
})
