import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { Command } from "commander"

import type { RootOptions } from "../cli.js"
import { loadConfig } from "../config/index.js"
import { VaultWriter } from "../store/vault.js"
import {
  AuthCommandError,
  authStatus,
  readAuthMetadata,
  recordAuthMetadata,
  resolveCanvasToken,
  storeCanvasToken,
  verifyCanvasToken,
} from "./auth.js"
import { clearAlert, raiseTokenAlert } from "./auth-alert.js"

type LoginOptions = {
  readonly account: string
  readonly expiresAt: string
}

const executeFile = promisify(execFile)

/** Best-effort browser open; never throws so `auth renew` stays usable headless. */
export async function openUrl(url: string): Promise<void> {
  try {
    await executeFile("open", [url])
  } catch {
    // The URL is already printed above; opening it is a convenience, not a requirement.
  }
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command("auth").description("Manage Canvas authentication")
  auth
    .command("verify")
    .description("Verify the Canvas token against the current user's profile")
    .action(async () => {
      const options = program.opts<RootOptions>()
      const configuration = loadConfig(options.config)
      const vault = new VaultWriter({
        root: configuration.vault.path,
        gitInit: configuration.vault.gitInit,
      })
      const localStatus = authStatus(
        readAuthMetadata(configuration.vault.path),
        configuration.renew.warnDaysBefore,
      )
      if (localStatus.kind === "expired") {
        await raiseTokenAlert({
          vault,
          canvasUrl: configuration.canvas.baseUrl,
          reason: { kind: "expired", expiresAt: localStatus.expiresAt },
        })
        throw new AuthCommandError(
          `EXPIRED: Canvas token expired at ${localStatus.expiresAt}. Run school auth renew, then school auth login.`,
        )
      }
      if (localStatus.kind === "renewal-warning") {
        console.warn(
          `WARNING: Canvas token expires in ${localStatus.daysRemaining} day(s) at ${localStatus.expiresAt}. Re-mint soon.`,
        )
      }
      const resolution = resolveCanvasToken(configuration.canvas.tokenEnv)
      switch (resolution.kind) {
        case "missing":
          throw new AuthCommandError(
            "Canvas token not found. Follow docs/auth-runbook.md to mint and store a token.",
          )
        case "resolved": {
          const verification = await verifyCanvasToken(
            configuration.canvas.baseUrl,
            resolution.token,
          )
          switch (verification.kind) {
            case "verified":
              console.log("Canvas authentication verified (HTTP 200)")
              console.log(`id: ${verification.profile.id}`)
              console.log(`name: ${verification.profile.name}`)
              console.log(`email: ${verification.profile.email}`)
              console.log(`login id: ${verification.profile.loginId}`)
              await clearAlert({ vaultPath: configuration.vault.path })
              return
            case "reauthentication-required":
              await raiseTokenAlert({
                vault,
                canvasUrl: configuration.canvas.baseUrl,
                reason: { kind: "unauthorized" },
              })
              throw new AuthCommandError(
                `Canvas returned HTTP ${verification.status}. Re-mint the token and run school auth login; see docs/auth-runbook.md.`,
              )
            case "rejected":
              throw new AuthCommandError(
                `Canvas verification failed with HTTP ${verification.status}.`,
              )
          }
        }
      }
    })

  const login = auth
    .command("login")
    .description(
      "Store the resolved Canvas token in macOS Keychain and record its confirmed expiry",
    )
    .requiredOption("--account <account>", "Keychain account for this Canvas token")
    .requiredOption("--expires-at <ISO-8601>", "confirmed token expiry timestamp from Canvas")
  login.action(async () => {
    const options = program.opts<RootOptions>()
    const loginOptions = login.opts<LoginOptions>()
    const configuration = loadConfig(options.config)
    const resolution = resolveCanvasToken(configuration.canvas.tokenEnv)
    switch (resolution.kind) {
      case "missing":
        throw new AuthCommandError(
          "Canvas token not found. Set CANVAS_TOKEN for this command; see docs/auth-runbook.md.",
        )
      case "resolved": {
        storeCanvasToken(loginOptions.account, resolution.token)
        const metadata = recordAuthMetadata({
          vaultPath: configuration.vault.path,
          account: loginOptions.account,
          baseUrl: configuration.canvas.baseUrl,
          expiresAt: loginOptions.expiresAt,
        })
        await clearAlert({ vaultPath: configuration.vault.path })
        console.log(
          `Canvas token stored in macOS Keychain; expiry recorded: ${metadata.expires_at}`,
        )
      }
    }
  })

  auth
    .command("status")
    .description("Show the recorded Canvas token renewal state")
    .action(async () => {
      const options = program.opts<RootOptions>()
      const configuration = loadConfig(options.config)
      const status = authStatus(
        readAuthMetadata(configuration.vault.path),
        configuration.renew.warnDaysBefore,
      )
      switch (status.kind) {
        case "unrecorded":
          console.log("No Canvas token expiry metadata recorded. See docs/auth-runbook.md.")
          return
        case "valid":
          console.log(`Canvas token expiry: ${status.expiresAt}`)
          await clearAlert({ vaultPath: configuration.vault.path })
          return
        case "renewal-warning":
          console.log(
            `WARNING: Canvas token expires in ${status.daysRemaining} day(s) at ${status.expiresAt}. Re-mint soon.`,
          )
          return
        case "expired": {
          const vault = new VaultWriter({
            root: configuration.vault.path,
            gitInit: configuration.vault.gitInit,
          })
          await raiseTokenAlert({
            vault,
            canvasUrl: configuration.canvas.baseUrl,
            reason: { kind: "expired", expiresAt: status.expiresAt },
          })
          throw new AuthCommandError(
            `EXPIRED: Canvas token expired at ${status.expiresAt}. Run school auth renew, then school auth login.`,
          )
        }
      }
    })

  auth
    .command("renew")
    .description("Print Canvas token renewal steps and open the Canvas token settings page")
    .action(async () => {
      const options = program.opts<RootOptions>()
      const configuration = loadConfig(options.config)
      const settingsUrl = new URL("/profile/settings", configuration.canvas.baseUrl).toString()
      console.log(
        "Canvas access tokens are minted in the Canvas UI only; this cannot do it for you.",
      )
      console.log("")
      console.log(`1. Open ${settingsUrl} (Account -> Settings -> New Access Token).`)
      console.log("2. Name the token and record the expiration timestamp Canvas displays.")
      console.log("3. Store it: school auth login --account <acct> --expires-at <ISO-8601>")
      console.log("4. Confirm it: school auth verify")
      console.log("")
      console.log("See docs/auth-runbook.md for full details.")
      await openUrl(settingsUrl)
    })
}
