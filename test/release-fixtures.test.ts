import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { redactCanvasFixture, scanFixtureSecrets } from "../src/canvas/fixtures.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

it("commits only synthetic Canvas hosts and no signed course links", async () => {
  const root = fileURLToPath(new URL("./fixtures/canvas/", import.meta.url))
  for (const name of await readdir(root)) {
    const content = await readFile(join(root, name), "utf8")
    const urls = content.match(/https?:\/\/[^\s"\\<>]+/g) ?? []
    for (const value of urls) {
      expect(new URL(value).hostname, name).toMatch(/\.(test|invalid)$/)
    }
    expect(content, name).not.toMatch(/verifier=|drive\.google\.com|@stanford\.edu/i)
  }
  await expect(scanFixtureSecrets(root)).resolves.toEqual([])
})

it("redacts signed links inside HTML and pagination headers", () => {
  const secret = "synthetic-download-key-long-enough"
  const url = `https://canvas.test/files/123?verifier=${secret}&wrap=1`
  const result = redactCanvasFixture({
    url: "https://canvas.test/api/v1/courses/123",
    status: 200,
    headers: { link: `<${url}>; rel="next"` },
    body: { description: `<a href="${url}">Example</a>`, verifier: secret },
  })
  expect(JSON.stringify(result)).not.toContain(secret)
})

it("rejects a fixture containing a signed download credential", async () => {
  const root = await temporaryDirectory("school-release-secret-")
  await writeFile(
    join(root, "fixture.json"),
    "https://canvas.test/file?verifier=synthetic-download-key-long-enough",
  )
  await expect(scanFixtureSecrets(root)).rejects.toThrow("Canvas fixture secret detected")
})
