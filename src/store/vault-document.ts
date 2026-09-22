import { createHash } from "node:crypto"

import matter from "gray-matter"
import { z } from "zod"

export const vaultSources = { sync: "sync", agent: "agent", user: "user" } as const
export const vaultStatuses = {
  draft: "draft",
  approved: "approved",
  final: "final",
  autoFinal: "auto-final",
} as const
export const vaultAiPolicies = { allowed: "allowed", prohibited: "prohibited" } as const
export const vaultRedistribution = { allowed: "allowed", restricted: "restricted" } as const

const frontmatterSchema = z.strictObject({
  canvas_id: z.string().min(1),
  canvas_url: z.url(),
  type: z.string().min(1),
  dates: z.record(z.string(), z.string().nullable()),
  // The canvas_id of the module this document was synced as an item of (an
  // assignment/file/page referenced from a module), when known. Optional and
  // backward compatible: documents synced before this field existed simply
  // omit it, and simulate's visibility rule treats that the same as "not in
  // any module" (falls through to the doc's own date signals).
  module_canvas_id: z.string().optional(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.enum([vaultSources.sync, vaultSources.agent, vaultSources.user]),
  status: z.enum([
    vaultStatuses.draft,
    vaultStatuses.approved,
    vaultStatuses.final,
    vaultStatuses.autoFinal,
  ]),
  ai_policy: z.enum([vaultAiPolicies.allowed, vaultAiPolicies.prohibited]),
  redistribution: z.enum([vaultRedistribution.allowed, vaultRedistribution.restricted]),
  model: z.string().min(1).optional(),
})

export type VaultFrontmatter = z.infer<typeof frontmatterSchema>
export type VaultSource = VaultFrontmatter["source"]
export type VaultStatus = VaultFrontmatter["status"]
export type VaultDocumentMetadataInput = {
  readonly canvasId: string | number
  readonly canvasUrl: string
  readonly type: string
  readonly content: string
  readonly dates?: Readonly<Record<string, string | null>>
  readonly source: VaultSource
  readonly status: VaultStatus
  readonly aiPolicy: VaultFrontmatter["ai_policy"]
  readonly redistribution?: VaultFrontmatter["redistribution"]
  readonly model?: string
  readonly moduleCanvasId?: string | number
}
export type ParsedVaultDocument = {
  readonly frontmatter: VaultFrontmatter
  readonly content: string
}

export class VaultDocumentError extends Error {
  readonly name = "VaultDocumentError"

  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Invalid vault document at ${path}: ${detail}`)
  }
}

export function createVaultFrontmatter(input: VaultDocumentMetadataInput): VaultFrontmatter {
  return {
    canvas_id: String(input.canvasId),
    canvas_url: input.canvasUrl,
    type: input.type,
    dates: { ...(input.dates ?? {}) },
    content_hash: createHash("sha256").update(input.content).digest("hex"),
    source: input.source,
    status: input.status,
    ai_policy: input.aiPolicy,
    redistribution: input.redistribution ?? vaultRedistribution.allowed,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.moduleCanvasId === undefined
      ? {}
      : { module_canvas_id: String(input.moduleCanvasId) }),
  }
}

export function parseVaultDocument(content: string, path = "<memory>"): ParsedVaultDocument {
  try {
    const parsed = matter(content)
    return { frontmatter: frontmatterSchema.parse(parsed.data), content: parsed.content }
  } catch (error: unknown) {
    throw new VaultDocumentError(path, error instanceof Error ? error.message : String(error))
  }
}

export function renderVaultDocument(frontmatter: VaultFrontmatter, content: string): string {
  return matter.stringify(content, frontmatterSchema.parse(frontmatter))
}
