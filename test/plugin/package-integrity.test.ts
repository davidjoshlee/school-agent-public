import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import matter from "gray-matter"
import { describe, expect, it } from "vitest"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const pluginRoot = path.join(repoRoot, "plugins/school-agent")
type PluginInterface = Record<string, unknown>
type PortableManifest = {
  $schema?: string
  name: string
  version: string
  description: string
  author?: Record<string, unknown>
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  skills?: unknown
  mcpServers?: unknown
  extensions?: {
    "com.openai"?: {
      interface?: PluginInterface
      apps?: unknown
      hooks?: unknown
    }
  }
}
type CodexManifest = PortableManifest & { interface?: PluginInterface; skills?: string }
const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, "utf8")) as T

async function walkMarkdown(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return walkMarkdown(fullPath)
      return entry.isFile() && entry.name.endsWith(".md") ? [fullPath] : []
    }),
  )
  return nested.flat()
}

describe("School Agent plugin package", () => {
  it("keeps portable and Codex manifests on one identity and metadata version", async () => {
    const portable = await readJson<PortableManifest>(path.join(pluginRoot, "plugin.json"))
    const codex = await readJson<CodexManifest>(path.join(pluginRoot, ".codex-plugin/plugin.json"))

    expect(portable.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json")
    expect(portable.name).toBe("school-agent")
    expect(portable.version).toBe("0.3.0")
    expect(portable.name).toBe(codex.name)
    expect(portable.version).toBe(codex.version)
    expect(portable.description).toBe(codex.description)
    expect(portable.author).toEqual(codex.author)
    expect(portable.homepage).toBe(codex.homepage)
    expect(portable.repository).toBe(codex.repository)
    expect(portable.license).toBe(codex.license)
    expect(portable.keywords).toEqual(codex.keywords)
    expect(portable.extensions?.["com.openai"]?.interface).toEqual(codex.interface)
    expect(portable.skills).toBeUndefined()
    expect(portable.mcpServers).toBeUndefined()
    expect(portable.extensions?.["com.openai"]?.apps).toBeUndefined()
    expect(portable.extensions?.["com.openai"]?.hooks).toBeUndefined()
  })

  it("discovers only valid skill folders with matching frontmatter names", async () => {
    const skillsRoot = path.join(pluginRoot, "skills")
    const directories = (await readdir(skillsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    expect(directories.length).toBeGreaterThan(0)
    for (const name of directories) {
      const skillFile = path.join(skillsRoot, name, "SKILL.md")
      const parsed = matter(await readFile(skillFile, "utf8"))
      expect(parsed.data.name, `${skillFile} frontmatter name`).toBe(name)
      expect(typeof parsed.data.description).toBe("string")
      expect(parsed.data.description.trim().length).toBeGreaterThan(0)
      expect(parsed.content.trim().length).toBeGreaterThan(0)
    }
  })

  it("resolves local documentation links and presents the documented install path", async () => {
    const docPath = path.join(repoRoot, "docs/PLUGIN.md")
    const docs = [docPath, ...(await walkMarkdown(pluginRoot))]
    const doc = await readFile(docPath, "utf8")
    for (const sourcePath of docs) {
      const source = await readFile(sourcePath, "utf8")
      const links = [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1])
      for (const link of links) {
        if (/^[a-z]+:/i.test(link) || link.startsWith("#")) continue
        const packageBase = sourcePath.startsWith(pluginRoot + path.sep) ? pluginRoot : repoRoot
        const target = path.resolve(
          path.dirname(sourcePath),
          decodeURIComponent(link.split("#")[0]),
        )
        expect(
          target.startsWith(packageBase + path.sep),
          `${sourcePath}: ${link} stays in its package`,
        ).toBe(true)
        await expect(stat(target), `${sourcePath}: ${link} resolves`).resolves.toBeTruthy()
      }
    }
    expect(doc).toContain("codex plugin marketplace add .")
    expect(doc).toContain("codex plugin add school-agent@personal")
    expect(doc).toContain("0.3.0")
    expect(doc).toContain("codex plugin remove school-agent@personal")
  })

  it("keeps the package skills-only and free of credential-shaped or live Canvas data", async () => {
    const files = [
      path.join(pluginRoot, "plugin.json"),
      path.join(pluginRoot, ".codex-plugin/plugin.json"),
      ...(await walkMarkdown(pluginRoot)),
      path.join(repoRoot, "docs/PLUGIN.md"),
    ]
    const text = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n")

    await expect(stat(path.join(pluginRoot, "mcp.json"))).rejects.toThrow()
    await expect(stat(path.join(pluginRoot, ".mcp.json"))).rejects.toThrow()
    await expect(stat(path.join(pluginRoot, ".app.json"))).rejects.toThrow()
    expect(text).not.toMatch(/sk-(?:proj|live|test)-[A-Za-z0-9_-]{12,}/)
    expect(text).not.toMatch(/https?:\/\/[^\s"')]+\.instructure\.com(?:\/|\b)/i)
    expect(text).not.toMatch(/https?:\/\/[^\s"')]+\.canvaslms\.com(?:\/|\b)/i)
  })
})
