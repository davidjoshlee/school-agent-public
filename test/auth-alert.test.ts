import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { clearAlert, raiseTokenAlert } from "../src/canvas/auth-alert.js"
import { VaultWriter } from "../src/store/vault.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

describe("token-renewal alert channel", () => {
  it("writes an actionable ALERT.md and calls the injected notifier for an expired token", async () => {
    // Given: an isolated vault and an injected notify spy.
    const vaultPath = await temporaryDirectory("school-agent-auth-alert-")
    const vault = new VaultWriter({ root: vaultPath, gitInit: false })
    const notify = vi.fn<(title: string, message: string) => Promise<void>>().mockResolvedValue()

    // When: an expired-token alert is raised.
    await raiseTokenAlert({
      vault,
      canvasUrl: "https://canvas.test",
      reason: { kind: "expired", expiresAt: "2026-07-31T00:00:00.000Z" },
      notify,
    })

    // Then: the durable channel names the problem and the fix, and the desktop channel fires.
    const alert = await readFile(join(vaultPath, "_meta", "ALERT.md"), "utf8")
    expect(alert).toContain("Canvas token expired")
    expect(alert).toContain("2026-07-31T00:00:00.000Z")
    expect(alert).toContain("school auth renew")
    expect(notify).toHaveBeenCalledWith(
      "School agent: Canvas token expired",
      expect.stringContaining("expired"),
    )
  })

  it("names a 401 rejection distinctly from an expired token", async () => {
    // Given: an isolated vault and an injected notify spy.
    const vaultPath = await temporaryDirectory("school-agent-auth-alert-401-")
    const vault = new VaultWriter({ root: vaultPath, gitInit: false })
    const notify = vi.fn<(title: string, message: string) => Promise<void>>().mockResolvedValue()

    // When: a 401 rejection is raised.
    await raiseTokenAlert({
      vault,
      canvasUrl: "https://canvas.test",
      reason: { kind: "unauthorized" },
      notify,
    })

    // Then: the alert names the 401 explicitly, with the same remediation.
    const alert = await readFile(join(vaultPath, "_meta", "ALERT.md"), "utf8")
    expect(alert).toContain("Canvas returned 401")
    expect(alert).toContain("school auth renew")
    expect(notify).toHaveBeenCalledOnce()
  })

  it("clears an existing alert and tolerates a missing one", async () => {
    // Given: a vault with a raised alert.
    const vaultPath = await temporaryDirectory("school-agent-auth-alert-clear-")
    const vault = new VaultWriter({ root: vaultPath, gitInit: false })
    const notify = vi.fn<(title: string, message: string) => Promise<void>>().mockResolvedValue()
    await raiseTokenAlert({
      vault,
      canvasUrl: "https://canvas.test",
      reason: { kind: "unauthorized" },
      notify,
    })

    // When: the alert is cleared, twice in a row.
    await clearAlert({ vaultPath })
    await expect(clearAlert({ vaultPath })).resolves.toBeUndefined()

    // Then: the alert file is gone, and clearing an already-clear alert never throws.
    await expect(readFile(join(vaultPath, "_meta", "ALERT.md"), "utf8")).rejects.toThrow()
  })
})
