import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { z } from "zod"

import { vaultPaths } from "../store/paths.js"

const keychainService = "school-agent-canvas" as const
const authMetadataSchema = z
  .strictObject({
    minted_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    account: z.string().min(1).optional(),
    baseUrl: z.url().optional(),
  })
  .refine(({ minted_at, expires_at }) => new Date(expires_at) > new Date(minted_at), {
    message: "expires_at must be after minted_at",
  })
const canvasTokenSchema = z.string().min(1).brand<"CanvasToken">()
const canvasProfileSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  primary_email: z.string().nullable().optional(),
  login_id: z.string().nullable().optional(),
})

export type CanvasToken = z.infer<typeof canvasTokenSchema>
export type AuthMetadata = z.infer<typeof authMetadataSchema>
export type RedactedCanvasProfile = {
  readonly id: string | number
  readonly name: string
  readonly email: string
  readonly loginId: string
}
export type TokenResolution =
  | {
      readonly kind: "resolved"
      readonly source: "environment" | "keychain"
      readonly token: CanvasToken
    }
  | { readonly kind: "missing" }
export type VerificationResult =
  | { readonly kind: "verified"; readonly profile: RedactedCanvasProfile }
  | { readonly kind: "reauthentication-required"; readonly status: 401 | 403 }
  | { readonly kind: "rejected"; readonly status: number }
export type AuthStatus =
  | { readonly kind: "unrecorded" }
  | { readonly kind: "valid"; readonly expiresAt: string }
  | { readonly kind: "renewal-warning"; readonly expiresAt: string; readonly daysRemaining: number }
  | { readonly kind: "expired"; readonly expiresAt: string }
export type AuthMetadataInput = {
  readonly vaultPath: string
  readonly account: string
  readonly baseUrl: string
  readonly expiresAt: string
  readonly now?: Date
}

export class AuthMetadataError extends Error {
  readonly name = "AuthMetadataError"

  constructor(readonly path: string) {
    super(`Invalid auth metadata: ${path}`)
  }
}

export class KeychainWriteError extends Error {
  readonly name = "KeychainWriteError"

  constructor() {
    super("Could not store Canvas token in macOS Keychain")
  }
}

export class AuthCommandError extends Error {
  readonly name = "AuthCommandError"
}

function metadataPath(vaultPath: string): string {
  return vaultPaths(vaultPath).metadata.auth
}

function maskValue(value: string): string {
  return value.length <= 2 ? "***" : `${value.slice(0, 1)}***${value.slice(-1)}`
}

function maskEmail(email: string): string {
  const at = email.lastIndexOf("@")
  return at > 0 ? `${maskValue(email.slice(0, at))}@${email.slice(at + 1)}` : maskValue(email)
}

function keychainToken(): CanvasToken | null {
  try {
    const token = execFileSync("security", ["find-generic-password", "-s", keychainService, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    const parsed = canvasTokenSchema.safeParse(token)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function resolveCanvasToken(tokenEnv: string, environment = process.env): TokenResolution {
  const environmentToken = environment[tokenEnv]
  const parsedEnvironmentToken = canvasTokenSchema.safeParse(environmentToken)
  if (parsedEnvironmentToken.success) {
    return { kind: "resolved", source: "environment", token: parsedEnvironmentToken.data }
  }
  const storedToken = keychainToken()
  return storedToken === null
    ? { kind: "missing" }
    : { kind: "resolved", source: "keychain", token: storedToken }
}

export async function verifyCanvasToken(
  baseUrl: string,
  token: CanvasToken,
): Promise<VerificationResult> {
  // This is deliberately the one bare self-endpoint request in Todo 3; Todo 5 owns the HTTP core.
  const response = await fetch(new URL("/api/v1/users/self", baseUrl), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 401 || response.status === 403) {
    return response.headers.has("www-authenticate")
      ? { kind: "reauthentication-required", status: response.status }
      : { kind: "rejected", status: response.status }
  }
  if (!response.ok) {
    return { kind: "rejected", status: response.status }
  }
  const profile = canvasProfileSchema.parse(await response.json())
  return {
    kind: "verified",
    profile: {
      id: profile.id,
      name: profile.name,
      email:
        profile.primary_email === undefined || profile.primary_email === null
          ? "unavailable"
          : maskEmail(profile.primary_email),
      loginId:
        profile.login_id === undefined || profile.login_id === null
          ? "unavailable"
          : maskValue(profile.login_id),
    },
  }
}

export function storeCanvasToken(account: string, token: CanvasToken): void {
  try {
    execFileSync(
      "security",
      ["add-generic-password", "-U", "-s", keychainService, "-a", account, "-w", token],
      { stdio: "ignore" },
    )
  } catch {
    throw new KeychainWriteError()
  }
}

export function recordAuthMetadata(input: AuthMetadataInput): AuthMetadata {
  const metadata = authMetadataSchema.parse({
    minted_at: (input.now ?? new Date()).toISOString(),
    expires_at: input.expiresAt,
    account: input.account,
    baseUrl: input.baseUrl,
  })
  const path = metadataPath(input.vaultPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, "utf8")
  return metadata
}

export function readAuthMetadata(vaultPath: string): AuthMetadata | null {
  const path = metadataPath(vaultPath)
  if (!existsSync(path)) {
    return null
  }
  try {
    return authMetadataSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      throw new AuthMetadataError(path)
    }
    throw error
  }
}

export function authStatus(
  metadata: AuthMetadata | null,
  warnDaysBefore: number,
  now = new Date(),
): AuthStatus {
  if (metadata === null) {
    return { kind: "unrecorded" }
  }
  const remainingMilliseconds = new Date(metadata.expires_at).getTime() - now.getTime()
  if (remainingMilliseconds < 0) {
    return { kind: "expired", expiresAt: metadata.expires_at }
  }
  const daysRemaining = Math.ceil(remainingMilliseconds / 86_400_000)
  return daysRemaining <= warnDaysBefore
    ? { kind: "renewal-warning", expiresAt: metadata.expires_at, daysRemaining }
    : { kind: "valid", expiresAt: metadata.expires_at }
}
