import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const secretPattern =
  /access_token=|Bearer\s+\d+~|(?:verifier|X-Amz-Signature|sig)=(?!%3Credacted|<redacted)[a-z0-9_-]{16,}/i
const fixtureHeaderNames = new Set([
  "authorization",
  "content-type",
  "link",
  "x-rate-limit-remaining",
  "x-request-cost",
])
const identifierResourceNames = new Set(["courses", "assignments", "quizzes", "files", "pages"])
const canvasResourcePath = /\/(courses|assignments|quizzes|files|pages)\/\d+(?=\/|\?|$)/g

function redactCanvasPath(value: string): string {
  return value
    .replace(canvasResourcePath, "/$1/<redacted-canvas-id>")
    .replace(
      /((?:[?&]|&amp;)(?:verifier|access_token|X-Amz-Signature|sig)=)[^&\s"'<>]+/gi,
      "$1<redacted-token>",
    )
}

export type RedactedCanvasFixture = {
  readonly url: string
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

export class FixtureSecretError extends Error {
  readonly name = "FixtureSecretError"
  readonly code = "CANVAS_FIXTURE_SECRET_DETECTED"

  constructor(readonly paths: readonly string[]) {
    super(`Canvas fixture secret detected in: ${paths.join(", ")}`)
  }
}

function redactBody(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactBody)
  }
  if (typeof value === "string") {
    return redactCanvasPath(value)
  }
  if (value === null || typeof value !== "object") {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      switch (key) {
        case "access_token":
          return [key, "<redacted-access-token>"]
        case "verifier":
          return [key, "<redacted-token>"]
        case "name":
        case "first_name":
        case "last_name":
        case "short_name":
        case "sortable_name":
          return [key, "<redacted-user-name>"]
        case "email":
          return [key, "<redacted-user-email>"]
        case "id":
        case "user_id":
          return [key, "<redacted-user-id>"]
        case "login_id":
          return [key, "<redacted-user-login-id>"]
        case "secure_params":
          return [key, "<redacted-canvas-secure-params>"]
        default:
          if (key.endsWith("_id")) {
            return [key, "<redacted-canvas-id>"]
          }
          return [key, redactBody(item)]
      }
    }),
  )
}

export function redactCanvasFixture(fixture: RedactedCanvasFixture): RedactedCanvasFixture {
  const url = new URL(fixture.url)
  const pathSegments = url.pathname.split("/")
  for (let index = 1; index < pathSegments.length; index += 1) {
    const resource = pathSegments[index - 1]
    if (resource !== undefined && identifierResourceNames.has(resource)) {
      pathSegments[index] = "<redacted-canvas-id>"
    }
  }
  url.pathname = redactCanvasPath(pathSegments.join("/"))
  if (url.searchParams.has("access_token")) {
    url.searchParams.set("access_token", "<redacted-access-token>")
  }
  for (const [key, value] of url.searchParams) {
    if (key === "context_codes[]" && value.startsWith("course_")) {
      url.searchParams.set(key, "course_<redacted-canvas-id>")
    }
  }
  const headers = Object.fromEntries(
    Object.entries(fixture.headers).flatMap(([key, value]) => {
      const normalizedKey = key.toLowerCase()
      if (!fixtureHeaderNames.has(normalizedKey)) {
        return []
      }
      return [
        [
          normalizedKey,
          normalizedKey === "authorization" && /^Bearer\s+/i.test(value)
            ? "Bearer <redacted-token>"
            : redactCanvasPath(value),
        ],
      ]
    }),
  )
  return { url: url.toString(), status: fixture.status, headers, body: redactBody(fixture.body) }
}

async function fixtureFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(root, entry.name)
      return entry.isDirectory() ? fixtureFiles(path) : [path]
    }),
  )
  return paths.flat()
}

export async function scanFixtureSecrets(root: URL | string): Promise<readonly []> {
  const rootPath = root instanceof URL ? fileURLToPath(root) : root
  const paths = await fixtureFiles(rootPath)
  const matches = (
    await Promise.all(
      paths.map(async (path) =>
        (await readFile(path, "utf8")).match(secretPattern) ? path : null,
      ),
    )
  ).filter((path): path is string => path !== null)
  if (matches.length > 0) {
    throw new FixtureSecretError(matches)
  }
  return []
}
