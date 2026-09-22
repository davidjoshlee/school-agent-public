import type { Command } from "commander"
import { loadConfig, persistCourseSelection, type SchoolConfig } from "../config/index.js"
import { createSchoolIndex } from "../store/db.js"
import { VaultWriter } from "../store/vault.js"
import { authStatus, readAuthMetadata } from "./auth.js"
import { raiseTokenAlert } from "./auth-alert.js"
import type { Course } from "./endpoints.js"
import { CanvasHttpClient } from "./http.js"
import { resolveSyncSelection } from "./resolve-sync-selection.js"
import { CanvasSyncAuthenticationError, syncCanvas } from "./sync.js"

type RootOptions = { readonly config: string }
type SyncOptions = { readonly course?: string; readonly full?: boolean }

type ResolvedRequest = {
  readonly courseIds: readonly string[]
  readonly overrides: Readonly<Record<string, Course>> | undefined
}

export function registerSyncCommand(program: Command): void {
  const sync = program
    .command("sync")
    .description("Synchronize selected Canvas courses into the local vault")
  sync.option("--course <id-or-code>", "sync one discovered Canvas course")
  sync.option("--full", "redownload current file metadata rather than using the incremental cache")
  sync.action(async () => {
    const root = program.opts<RootOptions>()
    const options = sync.opts<SyncOptions>()
    const configuration = loadConfig(root.config)
    const index = createSchoolIndex({ path: configuration.index.path })
    const client = new CanvasHttpClient({
      baseUrl: configuration.canvas.baseUrl,
      tokenEnv: configuration.canvas.tokenEnv,
    })
    const vault = new VaultWriter({
      root: configuration.vault.path,
      gitInit: configuration.vault.gitInit,
    })
    const localStatus = authStatus(
      readAuthMetadata(configuration.vault.path),
      configuration.renew.warnDaysBefore,
    )
    if (localStatus.kind === "expired") {
      console.error(
        `EXPIRED: Canvas token expired at ${localStatus.expiresAt}. This sync will likely fail; run school auth renew.`,
      )
      await raiseTokenAlert({
        vault,
        canvasUrl: configuration.canvas.baseUrl,
        reason: { kind: "expired", expiresAt: localStatus.expiresAt },
      })
    } else if (localStatus.kind === "renewal-warning") {
      console.warn(
        `WARNING: Canvas token expires in ${localStatus.daysRemaining} day(s) at ${localStatus.expiresAt}. Re-mint soon.`,
      )
    }
    try {
      const requestedCourse = options.course
      const resolved =
        requestedCourse === undefined
          ? undefined
          : await resolveRequest(client, configuration, requestedCourse)
      const courseIds =
        resolved?.courseIds ?? selectCourseIds(configuration.courses, requestedCourse)
      const report = await syncCanvas({
        client,
        canvasBaseUrl: configuration.canvas.baseUrl,
        vaultPath: configuration.vault.path,
        index,
        gitInit: configuration.vault.gitInit,
        maxFileSizeMB: configuration.files.maxSizeMB,
        restrictedFileHandling: configuration.restrictedFileHandling,
        leadDays: configuration.sync.leadDays,
        ...(options.full === true ? { full: true } : {}),
        ...(courseIds === undefined ? {} : { courseIds }),
        ...(resolved?.overrides === undefined ? {} : { courseOverrides: resolved.overrides }),
      })
      // A targeted `sync --course <id>` is a one-off, NOT a change to the recorded
      // course selection — it must never rewrite the allowlist (that clobbered it
      // to a single course). Only a full auto-mode sync records what it discovered.
      if (requestedCourse === undefined && configuration.courses.mode === "auto") {
        persistCourseSelection(root.config, courseIds ?? report.discoveredCourseIds)
      }
      for (const course of report.courses) {
        console.log(
          `${course.courseCode}\t${course.status}\tchanges=${course.changes.length}\tgaps=${course.gaps.length}`,
        )
      }
    } catch (error: unknown) {
      if (error instanceof CanvasSyncAuthenticationError) {
        await raiseTokenAlert({
          vault,
          canvasUrl: configuration.canvas.baseUrl,
          reason: { kind: "unauthorized" },
        })
      }
      throw error
    } finally {
      index.close()
    }
  })
}

function selectCourseIds(
  courses: { readonly mode: "auto" | "list"; readonly allowlist: readonly string[] },
  requestedCourse: string | undefined,
): readonly string[] | undefined {
  if (requestedCourse !== undefined) return [requestedCourse]
  return courses.mode === "list" ? courses.allowlist : undefined
}

async function resolveRequest(
  client: CanvasHttpClient,
  configuration: SchoolConfig,
  requestedCourse: string,
): Promise<ResolvedRequest> {
  const selection = await resolveSyncSelection(
    client,
    requestedCourse,
    configuration.courses.pilotCourseId ?? undefined,
  )
  return { courseIds: selection.courseIds, overrides: selection.courseOverrides }
}
