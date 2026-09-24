import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { HttpResponse, http } from "msw"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CanvasTokenUnavailableError,
  FixtureSecretError,
  RateLimitExceededError,
  redactCanvasFixture,
  scanFixtureSecrets,
  TokenExpiredError,
  WriteAttemptError,
} from "../src/canvas/http.js"
import { server } from "./helpers/canvasMock.js"
import { client } from "./helpers/schoolConfig.js"
import { temporaryDirectory } from "./helpers/tempDir.js"

afterEach(() => vi.useRealTimers())

describe("CanvasHttpClient", () => {
  it("gives actionable guidance when the configured environment token is missing", () => {
    expect(() => {
      throw new CanvasTokenUnavailableError("SCHOOL_CANVAS_TOKEN")
    }).toThrow("Set SCHOOL_CANVAS_TOKEN or follow docs/auth-runbook.md")
  })

  it("paginates a three-page Link chain in order and sends the bearer token on every page", async () => {
    // Given: three Canvas pages linked by RFC 5988 next relations.
    const requestedUrls: string[] = []
    const authorizations: string[] = []
    server.use(
      http.get("https://canvas.test/api/v1/courses", ({ request }) => {
        const url = new URL(request.url)
        requestedUrls.push(url.toString())
        authorizations.push(request.headers.get("authorization") ?? "")
        const page = url.searchParams.get("page") ?? "1"
        switch (page) {
          case "1":
            return HttpResponse.json(["first"], {
              headers: {
                Link: '<https://canvas.test/api/v1/courses?page=2>; rel="next"',
              },
            })
          case "2":
            return HttpResponse.json(["second"], {
              headers: {
                Link: '<https://canvas.test/api/v1/courses?page=3>; rel="next"',
              },
            })
          case "3":
            return HttpResponse.json(["third"])
          default:
            return new HttpResponse(null, { status: 400 })
        }
      }),
    )

    // When: the read-only client consumes the page iterator.
    const pages: unknown[] = []
    for await (const response of client({ random: () => 0 }).paginate("/api/v1/courses")) {
      pages.push(await response.json())
    }

    // Then: pages and per_page query parameters remain ordered across every request.
    expect(pages).toEqual([["first"], ["second"], ["third"]])
    expect(requestedUrls.map((url) => new URL(url).searchParams.get("per_page"))).toEqual([
      "100",
      "100",
      "100",
    ])
    expect(authorizations).toEqual([
      "Bearer fixture-token",
      "Bearer fixture-token",
      "Bearer fixture-token",
    ])
  })

  it("retries a 429 with exponential backoff and jitter", async () => {
    // Given: Canvas rate-limits the first request and accepts the retry.
    let requests = 0
    server.use(
      http.get("https://canvas.test/api/v1/users/self", () => {
        requests += 1
        return requests === 1
          ? new HttpResponse(null, { status: 429 })
          : HttpResponse.json({ id: "ok" })
      }),
    )
    vi.useFakeTimers()
    const timeout = vi.spyOn(globalThis, "setTimeout")

    // When: a request receives the retryable status.
    const response = client({ random: () => 0 }).get("/api/v1/users/self")
    await vi.runAllTimersAsync()

    // Then: the 1-second first exponential delay elapses before the successful retry.
    expect((await response).status).toBe(200)
    expect(requests).toBe(2)
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 1_000)
  })

  it("retries Canvas's 403 Rate Limit Exceeded response", async () => {
    // Given: Canvas uses its documented 403 rate-limit response first.
    let requests = 0
    server.use(
      http.get("https://canvas.test/api/v1/users/self", () => {
        requests += 1
        return requests === 1
          ? HttpResponse.json({ errors: [{ message: "Rate Limit Exceeded" }] }, { status: 403 })
          : HttpResponse.json({ id: "ok" })
      }),
    )
    vi.useFakeTimers()

    // When: the retryable 403 response is returned.
    const response = client({ random: () => 0 }).get("/api/v1/users/self")
    await vi.runAllTimersAsync()

    // Then: the client retries rather than treating it as an ordinary forbidden response.
    expect((await response).status).toBe(200)
    expect(requests).toBe(2)
  })

  it("retries a transient network error and then succeeds", async () => {
    // Given: the first fetch fails at the network layer (a timeout/blip), the retry succeeds.
    let requests = 0
    server.use(
      http.get("https://canvas.test/api/v1/users/self", () => {
        requests += 1
        return requests === 1 ? HttpResponse.error() : HttpResponse.json({ id: "ok" })
      }),
    )
    vi.useFakeTimers()

    // When: a request hits a transient fetch rejection rather than a status code.
    const response = client({ random: () => 0 }).get("/api/v1/users/self")
    await vi.runAllTimersAsync()

    // Then: the client backs off and retries instead of aborting the run.
    expect((await response).status).toBe(200)
    expect(requests).toBe(2)
  })

  it("retries a 5xx server error and then succeeds", async () => {
    // Given: Canvas returns a transient 503 first, then a healthy response.
    let requests = 0
    server.use(
      http.get("https://canvas.test/api/v1/users/self", () => {
        requests += 1
        return requests === 1
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json({ id: "ok" })
      }),
    )
    vi.useFakeTimers()

    // When: the request receives a retryable server error.
    const response = client({ random: () => 0 }).get("/api/v1/users/self")
    await vi.runAllTimersAsync()

    // Then: the client retries the 5xx rather than surfacing it as a hard CanvasHttpError.
    expect((await response).status).toBe(200)
    expect(requests).toBe(2)
  })

  it("throws RateLimitExceededError after either Canvas rate-limit response exhausts five attempts", async () => {
    // Given: persistent 429 and 403 rate-limit responses.
    let tooManyRequests = 0
    let forbiddenRateLimits = 0
    server.use(
      http.get("https://canvas.test/api/v1/too-many", () => {
        tooManyRequests += 1
        return new HttpResponse(null, { status: 429 })
      }),
      http.get("https://canvas.test/api/v1/forbidden-rate-limit", () => {
        forbiddenRateLimits += 1
        return HttpResponse.json({ message: "Rate Limit Exceeded" }, { status: 403 })
      }),
    )
    vi.useFakeTimers()

    // When: each rate-limited endpoint never recovers.
    const tooMany = client({ random: () => 0 }).get("/api/v1/too-many")
    const forbidden = client({ random: () => 0 }).get("/api/v1/forbidden-rate-limit")
    const tooManyFailure = expect(tooMany).rejects.toBeInstanceOf(RateLimitExceededError)
    const forbiddenFailure = expect(forbidden).rejects.toBeInstanceOf(RateLimitExceededError)
    await vi.runAllTimersAsync()

    // Then: retries stop at the typed five-attempt failure boundary.
    await Promise.all([tooManyFailure, forbiddenFailure])
    expect(tooManyRequests).toBe(5)
    expect(forbiddenRateLimits).toBe(5)
  })

  it("throws TokenExpiredError for a 401 with WWW-Authenticate", async () => {
    // Given: Canvas explicitly asks the user to authenticate again.
    server.use(
      http.get(
        "https://canvas.test/api/v1/users/self",
        () => new HttpResponse(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } }),
      ),
    )

    // When: the response reaches the HTTP core.
    const response = client({ random: () => 0 }).get("/api/v1/users/self")

    // Then: callers receive the typed token-expiry error.
    await expect(response).rejects.toBeInstanceOf(TokenExpiredError)
  })

  it("rejects every non-GET method without dispatching a request", async () => {
    // Given: a client and every prohibited request method.
    const methods = ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "get"]
    let dispatched = false
    server.use(
      http.all("https://canvas.test/api/v1/users/self", () => {
        dispatched = true
        return HttpResponse.json({})
      }),
    )

    // When: each non-GET method is requested.
    const attempts = await Promise.all(
      methods.map(async (method) => {
        try {
          await client({ random: () => 0 }).request(method, "/api/v1/users/self")
          return null
        } catch (error) {
          return error
        }
      }),
    )

    // Then: every attempt is rejected as a typed write attempt before network dispatch.
    expect(attempts.every((error) => error instanceof WriteAttemptError)).toBe(true)
    expect(dispatched).toBe(false)
  })
})

describe("Canvas fixture redaction", () => {
  it("redacts tokens, authorization headers, and Canvas user identity fields", () => {
    // Given: a response-shaped fixture with secrets and personal data.
    const fixture = {
      url: "https://canvas.test/api/v1/users/self?access_token=secret",
      status: 200,
      headers: {
        Authorization: "Bearer 123~secret",
        "Set-Cookie": "canvas_session=secret",
        "X-Canvas-User-Id": "123",
        "X-Request-Cost": "0.25",
      },
      body: {
        access_token: "secret",
        id: 123,
        name: "Ada Lovelace",
        email: "ada@example.test",
        login_id: "ada",
        first_name: "Ada",
        last_name: "Lovelace",
        short_name: "Ada",
        sortable_name: "Lovelace, Ada",
        user_id: 123,
      },
    }

    // When: the mandatory recorder redacts it.
    const redacted = redactCanvasFixture(fixture)

    // Then: every credential and identity value is replaced with a stable placeholder.
    expect(redacted).toEqual({
      url: "https://canvas.test/api/v1/users/self?access_token=%3Credacted-access-token%3E",
      status: 200,
      headers: { authorization: "Bearer <redacted-token>", "x-request-cost": "0.25" },
      body: {
        access_token: "<redacted-access-token>",
        id: "<redacted-user-id>",
        name: "<redacted-user-name>",
        email: "<redacted-user-email>",
        login_id: "<redacted-user-login-id>",
        first_name: "<redacted-user-name>",
        last_name: "<redacted-user-name>",
        short_name: "<redacted-user-name>",
        sortable_name: "<redacted-user-name>",
        user_id: "<redacted-user-id>",
      },
    })
  })

  it("reports a planted token string while the committed fixture corpus has zero matches", async () => {
    // Given: the committed fixtures and an isolated planted-secret fixture.
    const fixtureRoot = new URL("./fixtures/canvas/", import.meta.url)
    const plantedDirectory = await temporaryDirectory("school-agent-fixture-secret-")
    const plantedFixture = join(plantedDirectory, "planted.json")
    await writeFile(plantedFixture, "Bearer 123~secret", "utf8")

    // When: both fixture roots are scanned.
    const committed = scanFixtureSecrets(fixtureRoot)
    const planted = () => scanFixtureSecrets(plantedDirectory)

    // Then: committed fixtures are clean and a planted token fails the scanner.
    await expect(committed).resolves.toEqual([])
    await expect(planted()).rejects.toBeInstanceOf(FixtureSecretError)
  })
})
