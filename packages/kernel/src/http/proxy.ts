/**
 * `/peers/<name>/…` → the other daemon (spec 2026-10-07, D3). Why a proxy and not CORS: the browser
 * sees ONE origin — one service worker, one push subscription, one IndexedDB — and the origin
 * policy does not change. That is decided in ADR-0019.
 *
 * IT IS NOT AN OPEN PROXY. It goes to declared peers only, on the routes `peers.url()` allows,
 * with an outgoing URL that function built and checked by origin. It never follows a redirect. It
 * sits behind `originAllowed` and the 503 like every other API route (`server.ts`, `handle`).
 *
 * Bodies STREAM both ways: an upload to the other host is never held in memory here, and the
 * kernel's own body cap is not this code's to apply — the peer applies its own.
 */

import { request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { pipeline } from 'node:stream/promises'
import { errorBody, type ErrorCode, type Logger, type Timers } from '@factotum/core'
import { PEER_NAME, type PeerTable } from '../net/peers.ts'

/** `GET` and `HEAD`: reads. */
export const PROXY_TIMEOUT_MS = 10_000

/**
 * `POST` JSON. A launch runs git INSIDE the request: `status` (5 s) + `fetch` (8 s) + `rev-list`
 * (5 s) + `merge` (15 s) is 33 s at worst. 60 s leaves room.
 */
export const PROXY_POST_TIMEOUT_MS = 60_000

/** `POST` that is not JSON: the photos `api.upload` sends. A5 tunes it. */
export const PROXY_UPLOAD_TIMEOUT_MS = 120_000

/**
 * After the response headers, how long the body may go without a chunk (code review, 2026-10-08).
 * The fixed bounds above cover the wait for the headers only: a large download that keeps flowing
 * must not be cut at 10 s, and one that stalls must not hold a socket for the rest of the bound.
 */
export const PROXY_IDLE_TIMEOUT_MS = 30_000

/**
 * At most this many proxied requests at once (security review, 2026-10-08); past it, 503 without
 * calling the peer. A page holds a handful; 32 is room for thumbnails and bounds the sockets.
 */
export const PROXY_MAX_IN_FLIGHT = 32

/** The only request headers that travel. Never `Origin`, `Cookie`, `Host` or `Forwarded`. */
export const REQUEST_HEADERS = ['content-type', 'accept', 'content-length'] as const

/**
 * The only response headers that come back. The last three are `serve-file.ts`'s containment
 * headers: an attachment from the other host must arrive as contained as one from this one
 * (criterion 8) — and `pickResponse` forces them, so it is never LESS contained than here. NOT `content-length`: Node sends the body chunked, so a peer that compressed could
 * never leave the length disagreeing with what `fetch` decompressed.
 */
export const RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'content-disposition',
  'content-security-policy',
  'x-content-type-options',
] as const

/** The methods the modules' routes use. Anything else does not leave. */
const METHODS = new Set(['GET', 'HEAD', 'POST'])

export interface ProxyTimeouts {
  readonly read: number
  readonly json: number
  readonly upload: number
  /** After the headers: the longest silence between two chunks of the body. */
  readonly idle: number
}

export interface ProxyDeps {
  readonly peers: Pick<PeerTable, 'get' | 'url'>
  /** The kernel's own timers (CLAUDE.md §6). */
  readonly timers: Timers
  readonly log: Logger
  /** Tests scale them down; production uses the table above. */
  readonly timeouts?: Partial<ProxyTimeouts>
  /** Tests lower it; production uses PROXY_MAX_IN_FLIGHT. */
  readonly maxInFlight?: number
}

export interface Proxy {
  /** Called by `handle()` for `/peers` and `/peers/*`, after the origin check and the 503. */
  readonly handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /**
   * Aborts every request in flight. `BootHandle.stop` calls it BEFORE closing the server: closing
   * waits for open requests, and an upload to a peer that fell asleep would hold the shutdown for
   * up to two minutes.
   */
  readonly abortAll: () => void
}

/** The raw prefix: `/peers/<name>` followed by `/`. Read from `req.url` as received (design D3). */
const PREFIX = new RegExp(`^/peers/(${PEER_NAME.source.slice(1, -1)})(?=/)`)

export function createProxy(deps: ProxyDeps): Proxy {
  const timeouts: ProxyTimeouts = {
    read: deps.timeouts?.read ?? PROXY_TIMEOUT_MS,
    json: deps.timeouts?.json ?? PROXY_POST_TIMEOUT_MS,
    upload: deps.timeouts?.upload ?? PROXY_UPLOAD_TIMEOUT_MS,
    idle: deps.timeouts?.idle ?? PROXY_IDLE_TIMEOUT_MS,
  }
  const maxInFlight = deps.maxInFlight ?? PROXY_MAX_IN_FLIGHT
  const inFlight = new Set<AbortController>()

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET'
    const rawUrl = req.url ?? '/'
    const prefix = PREFIX.exec(rawUrl)
    const name = prefix?.[1]
    const target = name === undefined ? undefined : deps.peers.url(name, rawUrl.slice(prefix?.[0].length ?? 0))
    if (name === undefined || target === undefined || !METHODS.has(method)) {
      deps.log.info(`proxy ${method} refused → 404`)
      return refuse(req, res, 404, 'not-found', 'no such route on any peer')
    }

    const shape = shapeOf(target)
    const started = performance.now()
    const done = (status: number) => deps.log.info(`proxy ${method} ${name} ${shape} → ${status} ${Math.round(performance.now() - started)}ms`)

    if (deps.peers.get(name)?.reachable !== true) {
      done(502)
      return refuse(req, res, 502, 'peer-unreachable', `the host ${name} is unreachable`)
    }

    if (inFlight.size >= maxInFlight) {
      done(503)
      return refuse(req, res, 503, 'peer-unreachable', `too many requests to ${name} in flight; try again`)
    }

    const timeoutMs = timeoutFor(method, req.headers['content-type'], timeouts)
    const controller = new AbortController()
    inFlight.add(controller)
    // The fixed bound until the headers; from then on, re-armed by every chunk of the body.
    const deadline = watchdog(deps.timers, () => controller.abort())
    deadline.arm(timeoutMs)
    // The browser went away: so does the request to the peer.
    res.once('close', () => {
      if (!res.writableFinished) controller.abort()
    })

    try {
      const status = await forward(req, res, {
        method,
        target,
        name,
        timeoutMs,
        signal: controller.signal,
        onProgress: () => deadline.arm(timeouts.idle),
      })
      done(status)
    } finally {
      deadline.disarm()
      inFlight.delete(controller)
    }
  }

  return {
    handle,
    abortAll: () => {
      for (const controller of inFlight) controller.abort()
    },
  }
}

/**
 * Sends the request on and streams the answer back. Returns the status the browser got.
 *
 * `node:http`, NOT `fetch`, and it was measured (spec 2026-10-07, B6b): Node 26's `fetch`
 * (undici 8.3) pulls a streamed request body as fast as it can, whatever the socket says — a
 * 50 MB upload went through and sat in memory whole, with `Readable.toWeb`, an async iterable or a
 * pull stream alike, with and without `content-length`. Piped through `request`, the same upload
 * peaked at 2 MB. The URL is still the one `peers.url()` built; `request` follows no redirect.
 */
async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  call: {
    readonly method: string
    readonly target: URL
    readonly name: string
    readonly timeoutMs: number
    readonly signal: AbortSignal
    /** The headers arrived, or a chunk of the body did: the deadline becomes the idle one. */
    readonly onProgress: () => void
  },
): Promise<number> {
  const { method, target, name, signal } = call
  const unreachable = () =>
    signal.aborted ? `the host ${name} did not answer within ${call.timeoutMs}ms` : `the host ${name} did not answer`

  let response: IncomingMessage
  try {
    const hasBody = method !== 'GET' && method !== 'HEAD'
    // A body's length is announced only when a body is sent: a GET announcing bytes it never sends
    // leaves the peer waiting for them, and on a kept-alive connection reading the next request as
    // this one's body.
    const names = hasBody ? REQUEST_HEADERS : REQUEST_HEADERS.filter((header) => header !== 'content-length')
    response = await send(target, { method, headers: { ...pick(req.headers, names), 'accept-encoding': 'identity' }, signal }, hasBody ? req : undefined)
  } catch {
    // Never the error's message: it carries the peer's URL, and the path in it carries tokens.
    // An upload cut while its body is still going up sees a reset, not this 502: the browser is still
    // writing and the rest is never read. Accepted (code review 2026-10-08, ADR-0019).
    sendError(res, 502, 'peer-unreachable', unreachable())
    return 502
  }

  const status = response.statusCode ?? 502
  if (status >= 300 && status < 400) {
    response.resume()
    sendError(res, 502, 'peer-unreachable', `the host ${name} answered with a redirect, which is never followed`)
    return 502
  }

  call.onProgress()
  response.on('data', call.onProgress)
  res.writeHead(status, pickResponse(response.headers))
  try {
    await pipeline(response, res)
  } catch {
    // Cut mid-body — the idle timeout, the peer, or the browser. The status has gone; the socket goes too.
    res.destroy()
  }
  return status
}

/** One timer at a time on the kernel's timers: arming it again replaces the previous one. */
function watchdog(timers: Timers, fire: () => void): { readonly arm: (ms: number) => void; readonly disarm: () => void } {
  let current: Disposable | undefined
  const disarm = () => {
    current?.[Symbol.dispose]()
    current = undefined
  }
  return {
    arm: (ms) => {
      disarm()
      current = timers.setTimeout(fire, ms)
    },
    disarm,
  }
}

/** One request to the peer, resolved with its response. The body, if any, is piped — with backpressure. */
function send(
  target: URL,
  options: { readonly method: string; readonly headers: Record<string, string>; readonly signal: AbortSignal },
  body: IncomingMessage | undefined,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const make = target.protocol === 'https:' ? httpsRequest : httpRequest
    const out = make(target, { method: options.method, headers: options.headers, signal: options.signal }, resolve)
    // A body that does not match the length it announced is an error, never a request whose end
    // the peer has to guess. @types/node 22 declares the flag on `ServerResponse` only; it lives on
    // `OutgoingMessage`, and on a `ClientRequest` it throws ERR_HTTP_CONTENT_LENGTH_MISMATCH (measured).
    ;(out as ClientRequest & { strictContentLength: boolean }).strictContentLength = true
    out.on('error', reject)
    if (body === undefined) out.end()
    // A failure on either side destroys both; `out`'s error rejects above if no answer came yet.
    else void pipeline(body, out).catch(() => undefined)
  })
}

/**
 * Which timeout (design D3): reads are short, a JSON POST may run git, anything else is an upload.
 * A POST with no `content-type` is an upload — a `File` with no type is sent that way.
 */
function timeoutFor(method: string, contentType: string | undefined, timeouts: ProxyTimeouts): number {
  if (method === 'GET' || method === 'HEAD') return timeouts.read
  return /^application\/json\b/i.test(contentType ?? '') ? timeouts.json : timeouts.upload
}

/**
 * What the log may say about a route: `/health` or `/modules/<id>/…`, NEVER THE REST (criterion
 * 36). The capability tokens of `sessions` travel in the path — `asks/:askId`, `grants/:token`,
 * `questions/:token`, `uploads/:uploadId/:name` — and the whole path would put every ask of the
 * other host, answered from here, into this host's log.
 */
function shapeOf(target: URL): string {
  const id = /^\/modules\/([a-z0-9][a-z0-9-]*)/.exec(target.pathname)?.[1]
  return id === undefined ? '/health' : `/modules/${id}/…`
}

function pick(headers: IncomingMessage['headers'], names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = headers[name]
    if (typeof value === 'string') out[name] = value
  }
  return out
}

/** `serve-file.ts`'s sandbox, word for word: opened directly, a document gets no origin and no script. */
const SANDBOX = "default-src 'none'; sandbox"

/** The four raster types `rasterTypeOf` paints (`@factotum/core`, `sniff.ts`). SVG is not one. */
const INLINE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * The response headers, with CONTAINMENT DECIDED HERE AND NEVER BY THE PEER (security review,
 * 2026-10-08). Whatever the peer says, nothing is sniffed. JSON keeps the peer's headers — it is
 * what `fetch` reads, never painted. A raster image stays inline, because the chat paints it with an
 * `<img>` and a tap opens it in a tab (`rows.tsx`), but is sandboxed. Anything else is a sandboxed
 * download, whatever disposition and policy the peer sent: a compromised peer must not be able to
 * serve a document under this host's origin.
 */
function pickResponse(headers: IncomingMessage['headers']): Record<string, string> {
  const picked = pick(headers, RESPONSE_HEADERS)
  const media = (picked['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const contained = { ...picked, 'x-content-type-options': 'nosniff' }
  if (media === 'application/json') return contained
  if (INLINE_TYPES.has(media)) return { ...contained, 'content-security-policy': SANDBOX }
  return { ...contained, 'content-security-policy': SANDBOX, 'content-disposition': 'attachment' }
}

/**
 * An answer given WITHOUT reading the body. On a request that has one, the connection closes after
 * it: otherwise Node would read the whole unread body to keep the socket, which is the unbounded
 * read `body.ts` exists to avoid.
 */
function refuse(req: IncomingMessage, res: ServerResponse, status: number, code: ErrorCode, message: string): void {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  sendError(res, status, code, message, hasBody ? { connection: 'close' } : {})
}

function sendError(res: ServerResponse, status: number, code: ErrorCode, message: string, extra: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json', ...extra })
  res.end(JSON.stringify(errorBody(code, message)))
}
