import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, relative, resolve } from "node:path"

import { z } from "zod"

const modelFunctionSchema = z.enum([
  "extractSummary",
  "prepBrief",
  "assignmentDraft",
  "assignmentDiscuss",
  "coverageCompare",
  "playbookUpdate",
])

const functionModelsSchema = z.strictObject({
  extractSummary: z.string().min(1),
  prepBrief: z.string().min(1),
  assignmentDraft: z.string().min(1),
  assignmentDiscuss: z.string().min(1),
  coverageCompare: z.string().min(1),
  playbookUpdate: z.string().min(1),
})

const defaultModelsSchema = z.strictObject({
  models: z.strictObject({
    triage: z.string().min(1),
    generation: z.string().min(1),
    functions: functionModelsSchema,
  }),
})

const userModelsSchema = z
  .strictObject({
    triage: z.string().min(1),
    generation: z.string().min(1),
    functions: functionModelsSchema.partial().optional(),
  })
  .optional()

const userConfigSchema = z.strictObject({
  canvas: z
    .strictObject({
      baseUrl: z.url().default("https://canvas.stanford.edu"),
      tokenEnv: z.string().min(1).default("CANVAS_TOKEN"),
    })
    .prefault({}),
  vault: z
    .strictObject({
      path: z.string().min(1).default("~/Documents/GSB/vault"),
      gitInit: z.boolean().default(true),
    })
    .prefault({}),
  index: z
    .strictObject({
      path: z.string().min(1).default("~/Library/Application Support/school-agent/index.db"),
    })
    .prefault({}),
  models: userModelsSchema,
  aiPolicyDefault: z.enum(["allowed", "prohibited"]).default("allowed"),
  courses: z
    .strictObject({
      mode: z.enum(["auto", "list"]).default("auto"),
      allowlist: z.array(z.string().min(1)).default([]),
      pilotCourseId: z.string().min(1).nullable().default(null),
    })
    .prefault({}),
  sync: z
    .strictObject({
      intervalMinutes: z.number().positive().default(60),
      staleAfterHours: z.number().positive().default(24),
      leadDays: z.number().int().positive().default(7),
    })
    .prefault({}),
  assignments: z.strictObject({ autoDraftUpcoming: z.boolean().default(false) }).prefault({}),
  cost: z
    .strictObject({ maxMonthlySpendUSD: z.number().nonnegative().nullable().default(null) })
    .prefault({}),
  restrictedFileHandling: z.enum(["exclude", "local_only", "allow"]).default("exclude"),
  renew: z.strictObject({ warnDaysBefore: z.number().int().positive().default(5) }).prefault({}),
  files: z.strictObject({ maxSizeMB: z.number().positive().default(100) }).prefault({}),
  prep: z.strictObject({ granularity: z.enum(["week", "session"]).default("week") }).prefault({}),
})

export type ModelFunction = z.infer<typeof modelFunctionSchema>
export type SchoolConfig = Omit<z.infer<typeof userConfigSchema>, "models"> & {
  readonly models: z.infer<typeof defaultModelsSchema>["models"]
}

export class ConfigError extends Error {
  readonly name: string = "ConfigError"
}

export class UnsafeVaultPathError extends ConfigError {
  readonly name: string = "UnsafeVaultPathError"

  constructor(readonly path: string) {
    super(`REFUSING iCloud-synced vault path: ${path}. Choose a local-only vault path.`)
  }
}

function expandHomePath(path: string, homeDirectory: string): string {
  if (path === "~") {
    return homeDirectory
  }
  if (path.startsWith("~/")) {
    return resolve(homeDirectory, path.slice(2))
  }
  return resolve(path)
}

function isWithin(path: string, parent: string): boolean {
  const pathToParent = relative(parent, path)
  return pathToParent === "" || (!pathToParent.startsWith("..") && !pathToParent.startsWith("../"))
}

function existingAncestor(path: string): string {
  let candidate = path
  while (true) {
    try {
      return realpathSync(candidate)
    } catch {
      const parent = dirname(candidate)
      if (parent === candidate) {
        return candidate
      }
      candidate = parent
    }
  }
}

function assertLocalVaultPath(path: string, homeDirectory: string): void {
  const mobileDocuments = resolve(homeDirectory, "Library/Mobile Documents")
  const resolvedMobileDocuments = existsSync(mobileDocuments) ? realpathSync(mobileDocuments) : null
  const resolvedVaultAncestor = existingAncestor(path)
  if (
    isWithin(path, mobileDocuments) ||
    isWithin(resolvedVaultAncestor, mobileDocuments) ||
    (resolvedMobileDocuments !== null && isWithin(resolvedVaultAncestor, resolvedMobileDocuments))
  ) {
    throw new UnsafeVaultPathError(path)
  }
}

function defaultModels(): z.infer<typeof defaultModelsSchema>["models"] {
  const defaultsUrl = new URL("../../config/models.default.json", import.meta.url)
  const defaultModelsContent = readFileSync(defaultsUrl, "utf8")
  return defaultModelsSchema.parse(JSON.parse(defaultModelsContent)).models
}

function parseUserConfig(content: string): z.infer<typeof userConfigSchema> {
  try {
    return userConfigSchema.parse(JSON.parse(content))
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ConfigError(`Invalid school.config.json:\n${z.prettifyError(error)}`)
    }
    if (error instanceof SyntaxError) {
      throw new ConfigError(`Invalid school.config.json JSON: ${error.message}`)
    }
    throw error
  }
}

export function loadConfig(configPath: string, homeDirectory = homedir()): SchoolConfig {
  const userConfig = parseUserConfig(readFileSync(configPath, "utf8"))
  const defaults = defaultModels()
  const models =
    userConfig.models === undefined
      ? defaults
      : {
          triage: userConfig.models.triage,
          generation: userConfig.models.generation,
          functions: {
            extractSummary:
              userConfig.models.functions?.extractSummary ?? defaults.functions.extractSummary,
            prepBrief: userConfig.models.functions?.prepBrief ?? defaults.functions.prepBrief,
            assignmentDraft:
              userConfig.models.functions?.assignmentDraft ?? defaults.functions.assignmentDraft,
            assignmentDiscuss:
              userConfig.models.functions?.assignmentDiscuss ??
              defaults.functions.assignmentDiscuss,
            coverageCompare:
              userConfig.models.functions?.coverageCompare ?? defaults.functions.coverageCompare,
            playbookUpdate:
              userConfig.models.functions?.playbookUpdate ?? defaults.functions.playbookUpdate,
          },
        }
  const vaultPath = expandHomePath(userConfig.vault.path, homeDirectory)
  const indexPath = expandHomePath(userConfig.index.path, homeDirectory)
  assertLocalVaultPath(vaultPath, homeDirectory)

  return {
    ...userConfig,
    vault: { ...userConfig.vault, path: vaultPath },
    index: { path: indexPath },
    models,
  }
}

export function persistCourseSelection(configPath: string, courseIds: readonly string[]): void {
  const configuration = parseUserConfig(readFileSync(configPath, "utf8"))
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        ...configuration,
        courses: { ...configuration.courses, mode: "list", allowlist: [...new Set(courseIds)] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
}

export function persistPilotCourse(configPath: string, pilotCourseId: string): void {
  const configuration = parseUserConfig(readFileSync(configPath, "utf8"))
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        ...configuration,
        courses: { ...configuration.courses, pilotCourseId },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
}
