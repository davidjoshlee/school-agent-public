import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"
import { buildCourseManifest } from "../src/store/manifest.js"
import { vaultDocumentKinds } from "../src/store/paths.js"
import {
  createVaultFrontmatter,
  renderVaultDocument,
  vaultAiPolicies,
  vaultSources,
  vaultStatuses,
} from "../src/store/vault-document.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

describe("buildCourseManifest resilience", () => {
  it("skips a malformed vault document instead of aborting the whole manifest", async () => {
    // Given: a course with one well-formed guidance doc and one bare-markdown file
    // that has no frontmatter (e.g. hand-authored, or left by an interrupted run).
    const courseRoot = await temporaryDirectory("school-agent-manifest-skip-")
    const guidance = join(courseRoot, "guidance")
    await mkdir(guidance, { recursive: true })
    const goodBody = "# Good\n\nProper guidance."
    await writeFile(
      join(guidance, "good.md"),
      renderVaultDocument(
        createVaultFrontmatter({
          canvasId: "guidance-good",
          canvasUrl: "https://canvas.test/courses/1",
          type: vaultDocumentKinds.guidance,
          content: goodBody,
          source: vaultSources.user,
          status: vaultStatuses.final,
          aiPolicy: vaultAiPolicies.allowed,
        }),
        goodBody,
      ),
      "utf8",
    )
    await writeFile(join(guidance, "bad.md"), "# Bare markdown\n\nNo frontmatter here.\n", "utf8")

    // When: the manifest is rebuilt.
    const manifest = await buildCourseManifest({
      courseRoot,
      indexPath: join(courseRoot, "_index.md"),
      restrictedFileHandling: "exclude",
    })

    // Then: the good doc is listed and the malformed one is silently skipped, not fatal.
    expect(manifest).toContain("guidance/good.md")
    expect(manifest).not.toContain("guidance/bad.md")
  })
})
