import { unlink } from "node:fs/promises"

import { notifyWithOsascript } from "../engines/timeline-reminders.js"
import { vaultPaths } from "../store/paths.js"
import type { VaultWriter } from "../store/vault.js"
import { isEnoent } from "../util/errors.js"

export type TokenAlertNotifier = (title: string, message: string) => Promise<void>

export type TokenAlertReason =
  | { readonly kind: "expired"; readonly expiresAt: string }
  | { readonly kind: "unauthorized" }

export type RaiseTokenAlertInput = {
  readonly vault: Pick<VaultWriter, "writeMetadata">
  readonly canvasUrl: string
  readonly reason: TokenAlertReason
  readonly notify?: TokenAlertNotifier
}

export type ClearAlertInput = {
  readonly vaultPath: string
}

const remediation =
  "Fix: run `school auth renew` for step-by-step re-minting instructions, " +
  "then `school auth login --account <acct> --expires-at <ISO>`. See docs/auth-runbook.md."

/** Writes the durable ALERT.md remediation and fires the injectable desktop notification. */
export async function raiseTokenAlert(input: RaiseTokenAlertInput): Promise<void> {
  const { title, heading, detail } = describe(input.reason)
  const content = [`# ${heading}`, "", detail, "", remediation].join("\n")
  await input.vault.writeMetadata({
    artifact: "alert",
    canvasUrl: input.canvasUrl,
    content,
  })
  await (input.notify ?? notifyWithOsascript)(title, detail)
}

/** Clears a stale token alert. Contract: the alert clears on the next successful auth/sync. */
export async function clearAlert(input: ClearAlertInput): Promise<void> {
  try {
    await unlink(vaultPaths(input.vaultPath).metadata.alert)
  } catch (error: unknown) {
    if (!isEnoent(error)) throw error
  }
}

function describe(reason: TokenAlertReason): {
  readonly title: string
  readonly heading: string
  readonly detail: string
} {
  switch (reason.kind) {
    case "expired":
      return {
        title: "School agent: Canvas token expired",
        heading: "Canvas token expired",
        detail: `The recorded Canvas token expired at ${reason.expiresAt}.`,
      }
    case "unauthorized":
      return {
        title: "School agent: Canvas returned 401",
        heading: "Canvas returned 401",
        detail: "Canvas rejected the stored token (HTTP 401); re-authentication is required.",
      }
  }
}
