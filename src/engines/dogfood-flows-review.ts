/**
 * Builds dogfood flows 6-10 (co-edit, approve, token-renewal alert, gaps
 * re-check, cost report). See dogfood-flows.ts for flows 1-5 and
 * dogfood-cli.ts for the command that wires both halves together.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { authStatus, readAuthMetadata } from "../canvas/auth.js"
import { raiseTokenAlert } from "../canvas/auth-alert.js"
import type { SchoolConfig } from "../config/index.js"
import { startOfMonthIso } from "../models/cost.js"
import type { SchoolIndex } from "../store/db.js"
import { vaultPaths } from "../store/paths.js"
import { VaultWriter } from "../store/vault.js"
import { readOptional } from "../util/fs.js"
import { approveAssignment, discussAssignment, reviseAssignment } from "./assignment.js"
import { discussionRunner, gatedRunner } from "./dogfood-runners.js"
import {
  DogfoodEngineError,
  type DogfoodState,
  requireAssignment,
  requireCourse,
  requireDraftPath,
  requireDraftRunId,
} from "./dogfood-state.js"
import type { DogfoodFlow } from "./dogfood-types.js"
import { createGatewayTriage } from "./retrieve-triage.js"

export type DogfoodReviewFlowsInput = {
  readonly config: SchoolConfig
  readonly index: SchoolIndex
  readonly state: DogfoodState
}

export function buildReviewFlows(input: DogfoodReviewFlowsInput): readonly DogfoodFlow[] {
  return [
    coEditFlow(input),
    approveFlow(input),
    tokenAlertFlow(input),
    gapsFlow(input),
    costFlow(input),
  ]
}

function coEditFlow(input: DogfoodReviewFlowsInput): DogfoodFlow {
  return {
    name: "co-edit",
    kind: "auto",
    async run() {
      const course = requireCourse(input.state)
      const assignment = requireAssignment(input.state)
      const runId = requireDraftRunId(input.state)
      const draftPath = requireDraftPath(input.state)
      const original = await readFile(draftPath, "utf8")
      await writeFile(
        draftPath,
        `${original}\n\n<!-- dogfood hand-edit: ${new Date().toISOString()} -->\n`,
        "utf8",
      )

      const triage = createGatewayTriage(input.config, input.index)
      const revised = await reviseAssignment({
        vaultRoot: input.config.vault.path,
        config: input.config,
        runner: gatedRunner(input.config, "assignmentDraft"),
        runId,
        feedback: "Dogfood co-edit: tighten the intro paragraph and keep my inserted note.",
        index: input.index,
        triage,
      })
      const revisedContent = await readFile(revised.path, "utf8")
      if (revised.version <= 1 || revisedContent === original) {
        throw new DogfoodEngineError("revise did not produce a differing new draft version")
      }

      const before = await readOptional(draftPath)
      const discussion = await discussAssignment({
        vaultRoot: input.config.vault.path,
        config: input.config,
        course,
        assignment,
        runner: discussionRunner(input.config),
        message: "Dogfood discuss: what is the trickiest part of this assignment?",
        triage,
      })
      const discussionContent = await readFile(discussion.path, "utf8")
      if (
        !discussion.path.endsWith(".discuss.md") ||
        !discussionContent.includes("trickiest part")
      ) {
        throw new DogfoodEngineError("discuss did not log to a .discuss.md file")
      }
      const after = await readOptional(draftPath)
      if (before !== after) {
        throw new DogfoodEngineError("discuss unexpectedly wrote a new draft version")
      }

      return {
        evidence: `revisedVersion=${revised.version} revisedPath=${revised.path} discussPath=${discussion.path}`,
      }
    },
  }
}

function approveFlow(input: DogfoodReviewFlowsInput): DogfoodFlow {
  return {
    name: "approve",
    kind: "auto",
    async run() {
      const runId = requireDraftRunId(input.state)
      const result = await approveAssignment({
        vaultRoot: input.config.vault.path,
        config: input.config,
        runner: gatedRunner(input.config, "assignmentDraft"),
        runId,
      })
      const content = await readFile(result.path, "utf8")
      if (content.trim().length === 0) {
        throw new DogfoodEngineError("approved final artifact is empty")
      }
      return { evidence: result.path }
    },
  }
}

function tokenAlertFlow(input: DogfoodReviewFlowsInput): DogfoodFlow {
  return {
    name: "token-renewal alert",
    kind: "auto",
    async run() {
      const realAuthPath = vaultPaths(input.config.vault.path).metadata.auth
      const raw = await readOptional(realAuthPath)
      // Auth may live only in the Keychain/env with no auth.json expiry file. We
      // never mutate the real auth anyway — only an aged COPY — so when none is
      // recorded, synthesize a baseline and still exercise the aging → expired →
      // alert path rather than failing on a setup detail.
      const synthesized = raw === null
      const baseline = synthesized ? {} : (JSON.parse(raw) as Record<string, unknown>)
      const tempRoot = await mkdtemp(join(tmpdir(), "school-agent-dogfood-auth-"))
      try {
        const tempVaultPath = join(tempRoot, "vault")
        const tempAuthPaths = vaultPaths(tempVaultPath)
        await mkdir(tempAuthPaths.metadata.directory, { recursive: true })
        // Override BOTH dates so the copy is unambiguously expired and still
        // satisfies the schema's expires_at > minted_at rule, regardless of when
        // the real token was minted (or that there is no real auth at all).
        const nowMs = Date.now()
        const aged = {
          ...baseline,
          minted_at: new Date(nowMs - 2 * 24 * 60 * 60 * 1000).toISOString(),
          expires_at: new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(),
        }
        await writeFile(tempAuthPaths.metadata.auth, `${JSON.stringify(aged, null, 2)}\n`, "utf8")

        const status = authStatus(
          readAuthMetadata(tempVaultPath),
          input.config.renew.warnDaysBefore,
        )
        if (status.kind !== "expired") {
          throw new DogfoodEngineError(
            `expected the aged COPY to report expired, got ${status.kind}`,
          )
        }
        let notified = false
        await raiseTokenAlert({
          vault: new VaultWriter({ root: tempVaultPath, gitInit: false }),
          canvasUrl: input.config.canvas.baseUrl,
          reason: { kind: "expired", expiresAt: status.expiresAt },
          notify: async () => {
            notified = true
          },
        })
        if (!notified) {
          throw new DogfoodEngineError("raiseTokenAlert did not invoke the injected notifier")
        }
        return {
          evidence: `status=${status.kind} notified=${notified} (aged a temp ${synthesized ? "synthesized baseline" : "copy of the real auth.json"}; real auth untouched)`,
        }
      } finally {
        await rm(tempRoot, { recursive: true, force: true })
      }
    },
  }
}

function gapsFlow(input: DogfoodReviewFlowsInput): DogfoodFlow {
  return {
    name: "gaps re-check",
    kind: "auto",
    async run() {
      const gaps = input.state.gapsCount
      const permissionGaps = input.state.permissionGapsCount
      if (gaps === undefined || permissionGaps === undefined) {
        throw new DogfoodEngineError("no sync gap counts available; the sync flow must run first")
      }
      return { evidence: `gaps=${gaps} permissionGaps=${permissionGaps}` }
    },
  }
}

function costFlow(input: DogfoodReviewFlowsInput): DogfoodFlow {
  return {
    name: "cost report",
    kind: "auto",
    async run() {
      const now = new Date()
      const summary = input.index.costSummary({ since: startOfMonthIso(now) })
      return { evidence: `monthToDateCostUsd=${summary.totalCostUsd.toFixed(4)}` }
    },
  }
}
