import { readFile, writeFile } from "node:fs/promises"

import {
  createVaultFrontmatter,
  parseVaultDocument,
  renderVaultDocument,
} from "../store/vault-document.js"
import { parseAssignmentProvenance } from "./assignment.js"

const simulationTimestamp = "1970-01-01T00:00:00.000Z"

export async function normalizeSimulationDraft(path: string): Promise<void> {
  const document = parseVaultDocument(await readFile(path, "utf8"), path)
  const provenance = parseAssignmentProvenance(document.content)
  const content = document.content.replace(provenance.timestamp, simulationTimestamp)
  const frontmatter = createVaultFrontmatter({
    canvasId: document.frontmatter.canvas_id,
    canvasUrl: document.frontmatter.canvas_url,
    type: document.frontmatter.type,
    content,
    dates: document.frontmatter.dates,
    source: document.frontmatter.source,
    status: document.frontmatter.status,
    aiPolicy: document.frontmatter.ai_policy,
    redistribution: document.frontmatter.redistribution,
    ...(document.frontmatter.model === undefined ? {} : { model: document.frontmatter.model }),
  })
  await writeFile(path, renderVaultDocument(frontmatter, content), "utf8")
}
