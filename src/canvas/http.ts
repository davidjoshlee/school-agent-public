import { resolveCanvasToken } from "./auth.js"

export { FixtureSecretError, redactCanvasFixture, scanFixtureSecrets } from "./fixtures.js"

const pageSize = 100
const rateLimitThreshold = 10
const retryAttemptLimit = 5
const retryBaseDelayMilliseconds = 1_000
const retryJitterMilliseconds = 250
const downloadTimeout = 60_000

// A fetch rejection worth retrying: AbortSignal.timeout throws TimeoutError, a
// manual abort throws AbortError, and a network-layer failure throws TypeError
// ("fetch failed"). Deterministic HTTP statuses are handled by status code, not
// here — this covers only the cases where fetch itself never returns a Response.
function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return error.name === "TimeoutError" || error.name === "AbortError" || error.name === "TypeError"
}

type Environment = Readonly<Record<string, string | undefined>>
type Sleep = (milliseconds: number) => Promise<void>
type RequestCostReporter = (total: number) => void

export type CanvasHttpClientOptions = {
  readonly baseUrl: string
  readonly tokenEnv: string
  readonly environment?: Environment
  readonly sleep?: Sleep
  readonly random?: () => number
  readonly reportRequestCost?: RequestCostReporter
}

type RequestRun = {
  requestCost: number
}

export class WriteAttemptError extends Error {
  readonly name = "WriteAttemptError"
  readonly code = "CANVAS_WRITE_ATTEMPT"

  constructor(readonly method: string) {
    super(`Canvas HTTP core only permits GET requests; refused ${method}`)
  }
}

export class TokenExpiredError extends Error {
  readonly name = "TokenExpiredError"
  readonly code = "CANVAS_TOKEN_EXPIRED"

  constructor() {
    super("Canvas token expired or is no longer authorized")
  }
}

export class CanvasHttpError extends Error {
  readonly name = "CanvasHttpError"
  readonly code = "CANVAS_HTTP_ERROR"

  constructor(readonly status: number) {
    super(`Canvas request failed with HTTP ${status}`)
  }
}

export class RateLimitExceededError extends Error {
  readonly name = "RateLimitExceededError"
  readonly code = "CANVAS_RATE_LIMIT_EXHAUSTED"

  constructor(readonly attempts: number) {
    super(`Canvas rate limit remained active after ${attempts} attempts`)
  }
}

export class CanvasTokenUnavailableError extends Error {
  readonly name = "CanvasTokenUnavailableError"
  readonly code = "CANVAS_TOKEN_UNAVAILABLE"

  constructor() {
    super("Canvas token is unavailable")
  }
}

export class CanvasEndpointError extends Error {
  readonly name = "CanvasEndpointError"
  readonly code = "CANVAS_ENDPOINT_REJECTED"

  constructor(readonly endpoint: string) {
    super("Canvas endpoint must remain on the configured origin and cannot include access_token")
  }
}

/** The Canvas 403/404 status callers treat as a permission gap, or null otherwise. */
export function permissionDeniedStatus(error: unknown): 403 | 404 | null {
  return error instanceof CanvasHttpError && (error.status === 403 || error.status === 404)
    ? error.status
    : null
}

/** True when `error` is a Canvas 403/404 — the shape callers treat as a permission gap. */
export function isPermissionDenied(error: unknown): boolean {
  return permissionDeniedStatus(error) !== null
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve_) => setTimeout(resolve_, milliseconds))
}

function requestCost(headers: Headers): number {
  const value = Number(headers.get("x-request-cost"))
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function remainingRequests(headers: Headers): number | null {
  const header = headers.get("x-rate-limit-remaining")
  if (header === null) {
    return null
  }
  const value = Number(header)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function nextLink(headers: Headers, currentUrl: URL): URL | null {
  const link = headers.get("link")
  if (link === null) {
    return null
  }
  for (const entry of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/i.exec(entry)
    if (match?.[1] !== undefined) {
      return new URL(match[1], currentUrl)
    }
  }
  return null
}

export class CanvasHttpClient {
  readonly #baseUrl: URL
  readonly #token: string
  readonly #sleep: Sleep
  readonly #random: () => number
  readonly #reportRequestCost: RequestCostReporter

  constructor(options: CanvasHttpClientOptions) {
    this.#baseUrl = new URL(options.baseUrl)
    const resolution = resolveCanvasToken(options.tokenEnv, options.environment)
    if (resolution.kind === "missing") {
      throw new CanvasTokenUnavailableError()
    }
    this.#token = resolution.token
    this.#sleep = options.sleep ?? defaultSleep
    this.#random = options.random ?? Math.random
    this.#reportRequestCost =
      options.reportRequestCost ??
      ((total) => {
        console.info(`Canvas request cost total: ${total}`)
      })
  }

  async request(method: string, endpoint: string): Promise<Response> {
    if (method !== "GET") {
      throw new WriteAttemptError(method)
    }
    const run = { requestCost: 0 }
    try {
      return await this.#dispatch(this.#endpointUrl(endpoint), run)
    } finally {
      this.#reportRequestCost(run.requestCost)
    }
  }

  get(endpoint: string): Promise<Response> {
    return this.request("GET", endpoint)
  }

  async download(url: string): Promise<Response> {
    const target = new URL(url, this.#baseUrl)
    if (target.origin !== this.#baseUrl.origin) {
      throw new CanvasEndpointError(url)
    }
    const run = { requestCost: 0 }
    try {
      return await this.#downloadDispatch(target, run)
    } finally {
      this.#reportRequestCost(run.requestCost)
    }
  }

  async *paginate(endpoint: string): AsyncGenerator<Response> {
    const run = { requestCost: 0 }
    let next: URL | null = this.#endpointUrl(endpoint)
    try {
      while (next !== null) {
        const response = await this.#dispatch(next, run)
        yield response
        const candidate = nextLink(response.headers, next)
        next = candidate === null ? null : this.#endpointUrl(candidate.toString())
      }
    } finally {
      this.#reportRequestCost(run.requestCost)
    }
  }

  #endpointUrl(endpoint: string): URL {
    const url = new URL(endpoint, this.#baseUrl)
    if (url.origin !== this.#baseUrl.origin || url.searchParams.has("access_token")) {
      throw new CanvasEndpointError(endpoint)
    }
    url.searchParams.set("per_page", String(pageSize))
    return url
  }

  async #dispatch(url: URL, run: RequestRun): Promise<Response> {
    for (let attempt = 1; attempt <= retryAttemptLimit; attempt += 1) {
      let response: Response
      try {
        response = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${this.#token}` },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        })
      } catch (error: unknown) {
        // A transient timeout or network blip should not abort a long
        // multi-request sync on a single slow response — back off and retry.
        if (isTransientFetchError(error) && attempt < retryAttemptLimit) {
          await this.#sleep(this.#backoffDelay(attempt))
          continue
        }
        throw error
      }
      run.requestCost += requestCost(response.headers)
      const remaining = remainingRequests(response.headers)
      if (remaining !== null && remaining < rateLimitThreshold) {
        await this.#sleep(retryBaseDelayMilliseconds)
      }
      if (response.status === 401 && response.headers.has("www-authenticate")) {
        throw new TokenExpiredError()
      }
      if (
        response.status === 429 ||
        (response.status === 403 && (await response.clone().text()).includes("Rate Limit Exceeded"))
      ) {
        if (attempt === retryAttemptLimit) {
          throw new RateLimitExceededError(attempt)
        }
        await this.#sleep(this.#backoffDelay(attempt))
        continue
      }
      // A transient server error (5xx) is worth a retry; a deterministic 4xx is not.
      if (response.status >= 500 && attempt < retryAttemptLimit) {
        await this.#sleep(this.#backoffDelay(attempt))
        continue
      }
      if (!response.ok) {
        throw new CanvasHttpError(response.status)
      }
      return response
    }
    throw new RateLimitExceededError(retryAttemptLimit)
  }

  #backoffDelay(attempt: number): number {
    return (
      retryBaseDelayMilliseconds * 2 ** (attempt - 1) +
      Math.floor(this.#random() * retryJitterMilliseconds)
    )
  }

  async #downloadDispatch(url: URL, run: RequestRun): Promise<Response> {
    for (let attempt = 1; attempt <= retryAttemptLimit; attempt += 1) {
      // The verifier URL is pre-signed: it is self-authenticating and redirects to
      // cross-origin storage, so send no Authorization header and follow redirects
      // (the token must never leak to a CDN).
      let response: Response
      try {
        response = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(downloadTimeout),
        })
      } catch (error: unknown) {
        if (isTransientFetchError(error) && attempt < retryAttemptLimit) {
          await this.#sleep(this.#backoffDelay(attempt))
          continue
        }
        throw error
      }
      run.requestCost += requestCost(response.headers)
      if (response.status === 429) {
        if (attempt === retryAttemptLimit) {
          throw new RateLimitExceededError(attempt)
        }
        await this.#sleep(this.#backoffDelay(attempt))
        continue
      }
      if (response.status >= 500 && attempt < retryAttemptLimit) {
        await this.#sleep(this.#backoffDelay(attempt))
        continue
      }
      if (!response.ok) {
        throw new CanvasHttpError(response.status)
      }
      return response
    }
    throw new RateLimitExceededError(retryAttemptLimit)
  }
}
