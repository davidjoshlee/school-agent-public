import { afterEach, expect, it, vi } from "vitest"
import { checkAiReadiness } from "../../src/models/ai-readiness.js"
import { schoolConfig } from "../helpers/schoolConfig.js"

const sdk = vi.hoisted(() => ({ generateText: vi.fn(), createGateway: vi.fn() }))
vi.mock("ai", () => sdk)

afterEach(() => {
  vi.unstubAllGlobals()
  sdk.generateText.mockReset()
  sdk.createGateway.mockReset()
})

it("binds the supplied key and bounds synthetic requests without logging generated text", async () => {
  const config = schoolConfig({ vaultPath: "/tmp/synthetic-readiness" })
  const ids = [
    ...new Set([
      config.models.triage,
      config.models.generation,
      ...Object.values(config.models.functions),
    ]),
  ]
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id, type: "language" })) })),
  )
  vi.stubGlobal("fetch", fetchMock)
  sdk.createGateway.mockReturnValue((id: string) => id)
  sdk.generateText.mockResolvedValue({ text: "synthetic provider text not for logs" })

  const result = await checkAiReadiness(config, "synthetic-selected-key")
  expect(result.healthy).toBe(true)
  expect(fetchMock).toHaveBeenCalledWith("https://ai-gateway.vercel.sh/v1/models", {
    signal: expect.any(AbortSignal),
  })
  expect(sdk.createGateway).toHaveBeenCalledWith({ apiKey: "synthetic-selected-key" })
  expect(sdk.generateText).toHaveBeenCalledTimes(ids.length)
  for (const [request] of sdk.generateText.mock.calls) {
    expect(request).toMatchObject({
      prompt: "Reply with READY.",
      maxOutputTokens: 16,
      maxRetries: 0,
      timeout: 10_000,
    })
    expect(request.abortSignal).toBeInstanceOf(AbortSignal)
  }
  expect(JSON.stringify(result)).not.toContain("synthetic provider text")
  expect(JSON.stringify(result)).not.toContain("synthetic-selected-key")
})

it("rejects an empty provider response instead of declaring readiness", async () => {
  const config = schoolConfig({ vaultPath: "/tmp/synthetic-readiness" })
  const ids = [
    ...new Set([
      config.models.triage,
      config.models.generation,
      ...Object.values(config.models.functions),
    ]),
  ]
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: ids.map((id) => ({ id, type: "language" })) })),
    ),
  )
  sdk.createGateway.mockReturnValue((id: string) => id)
  sdk.generateText.mockResolvedValue({ text: "" })
  expect((await checkAiReadiness(config, "synthetic-key")).healthy).toBe(false)
})
