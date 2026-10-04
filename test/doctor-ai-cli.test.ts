import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { runCli } from "../src/cli.js"
import { createStarterConfig } from "../src/config/setup.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

const probe = vi.hoisted(() => vi.fn())
vi.mock("../src/models/ai-readiness.js", () => ({ checkAiReadiness: probe }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  probe.mockReset()
})

async function fixture() {
  const root = await temporaryDirectory("school-doctor-cli-")
  const path = join(root, "school.config.json")
  createStarterConfig(path, { canvasUrl: "https://canvas.test" }, root)
  await writeFile(
    join(root, ".env"),
    "CANVAS_TOKEN=synthetic-token\nAI_GATEWAY_API_KEY=synthetic-key\n",
  )
  vi.stubEnv("CANVAS_TOKEN", "synthetic-token")
  vi.stubEnv("AI_GATEWAY_API_KEY", "synthetic-key")
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  return path
}

it("does not run an AI probe without explicit --ai", async () => {
  const path = await fixture()
  expect(await runCli(["--config", path, "doctor"])).toBe(0)
  expect(probe).not.toHaveBeenCalled()
})

it("runs an opted-in probe with the selected key and reports failure nonzero", async () => {
  const path = await fixture()
  probe.mockResolvedValue({
    healthy: true,
    findings: [{ level: "ok", message: "Synthetic success" }],
  })
  expect(await runCli(["--config", path, "doctor", "--ai"])).toBe(0)
  expect(probe).toHaveBeenCalledWith(expect.any(Object), "synthetic-key", undefined, undefined)
  probe.mockResolvedValue({
    healthy: false,
    findings: [{ level: "error", message: "Synthetic failure" }],
  })
  expect(await runCli(["--config", path, "doctor", "--ai"])).toBe(1)
})

it("does not spend on probes when local doctor checks fail", async () => {
  const path = await fixture()
  vi.stubEnv("CANVAS_TOKEN", "")
  expect(await runCli(["--config", path, "doctor", "--ai"])).toBe(1)
  expect(probe).not.toHaveBeenCalled()
})
