/**
 * The module's only way out to the web (design D14 «La red»): the scout, the address check, the
 * live-ad check and «paste a link» all fetch through `createNet(...).get`.
 *
 * What it guarantees, each with a test: only `https:` on its default port; at most `MAX_REDIRECTS` redirects, each one
 * re-checked exactly like the first URL; LinkedIn and its subdomains are never fetched (guardrail 5);
 * a name that resolves to loopback, a private, link-local, CGNAT (the tailnet) or otherwise
 * non-public address is refused, so pasting a link cannot become an SSRF against this daemon or the
 * other host; `TIMEOUT_MS` per request; `BODY_CAP_BYTES` read at most; an honest `User-Agent`; and
 * one request at a time per host, `politeMs` apart (guardrail 6).
 *
 * The world is injected — `fetch`, the DNS `lookup`, the timers and the clock — so no test touches
 * the network. Expected failures come back as a `NetResult`; nothing here throws for them.
 *
 * The transport is the global `fetch` with `redirect: 'manual'`: this package never imports Node's
 * HTTP modules (requirements crit. 70).
 *
 * DECLARED RESIDUAL RISK — DNS rebinding. The name is resolved and checked here, and then `fetch`
 * resolves it again on its own to connect. A hostile resolver answering a public address to the
 * first question and a private one to the second gets through. Closing it means pinning the
 * connection to the checked address, which `fetch` cannot do without a custom dispatcher. To be
 * recorded in §M (task N5).
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import type { Timers } from '@factotum/core'

export const USER_AGENT = 'factotum-jobs/0 (personal job search)'
export const MAX_REDIRECTS = 5
export const TIMEOUT_MS = 20_000
export const BODY_CAP_BYTES = 1024 * 1024

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** Guardrail 5. `lnkd.in` is LinkedIn's own shortener: following it would land on LinkedIn. */
const DENIED_DOMAINS: readonly string[] = ['linkedin.com', 'lnkd.in']

// ---------------------------------------------------------------------------------------------
// Results

export type NetFailure =
  | 'bad-url'
  | 'not-https'
  | 'linkedin'
  | 'private-address'
  | 'dns'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'too-large'
  | 'too-many-redirects'

/** `code` is the `JobsError` code (design D2) a caller can pass up as is; `kind` says exactly what. */
export interface NetError {
  readonly code: 'invalid' | 'blocked' | 'limit' | 'module-error'
  readonly kind: NetFailure
  readonly reason: string
}

export type NetResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: NetError }

const CODE_OF: Readonly<Record<NetFailure, NetError['code']>> = {
  'bad-url': 'invalid',
  'not-https': 'invalid',
  linkedin: 'blocked',
  'private-address': 'blocked',
  dns: 'module-error',
  network: 'module-error',
  timeout: 'module-error',
  aborted: 'module-error',
  'too-large': 'limit',
  'too-many-redirects': 'limit',
}

function ok<T>(value: T): NetResult<T> {
  return { ok: true, value }
}

function fail(kind: NetFailure, reason: string): { readonly ok: false; readonly error: NetError } {
  return { ok: false, error: { code: CODE_OF[kind], kind, reason } }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------------------------
// Address ranges.
//
// A DECLARED COPY of the idea in `packages/kernel/src/net/ranges.ts` (parsing to bytes, CIDR by
// bytes): packages/jobs may not import the kernel. The ranges differ — the kernel decides where it
// may LISTEN, this decides where the module may not CONNECT — and so does one rule: an address
// embedding an IPv4 one (IPv4-mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002:aabb:ccdd::`) is unwrapped FIRST and
// the IPv4 is checked after. `::ffff:0.0.0.0` has two non-zero bytes (CLAUDE.md §2).

type Bytes = readonly number[]

const DENIED_V4: readonly string[] = [
  '0.0.0.0/8', // "this network", 0.0.0.0 included
  '10.0.0.0/8',
  '100.64.0.0/10', // CGNAT — the tailnet
  '127.0.0.0/8',
  '169.254.0.0/16', // link-local, cloud metadata
  '172.16.0.0/12',
  '192.168.0.0/16',
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved and broadcast
  // Special-purpose (RFC 6890): never a company's web server.
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1
  '192.88.99.0/24', // the deprecated 6to4 relay anycast
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
]

const DENIED_V6: readonly string[] = [
  '::/96', // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
  '::ffff:0:0:0/96', // SIIT IPv4-translated (RFC 2765): a translator's, never a public server's
  '64:ff9b:1::/48', // local-use NAT64 (RFC 8215): the network's own translator
  '2001::/32', // Teredo: the IPv4 inside is obfuscated, so it cannot be judged
  '2001:db8::/32', // documentation
  'fc00::/7', // unique local, Tailscale's fd7a:115c:a1e0::/48 included
  'fe80::/10', // link-local
  'fec0::/10', // deprecated site-local, still routed inside some networks
  'ff00::/8', // multicast
]

/** Prefixes whose last four bytes are an IPv4 address: IPv4-mapped and the NAT64 well-known one. */
const EMBEDS_V4: readonly Bytes[] = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff],
  [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0],
]

/** 6to4 (`2002::/16`) carries its IPv4 address in bytes 2–5. */
const SIX_TO_FOUR: Bytes = [0x20, 0x02]

function parseIPv4(address: string): Bytes | undefined {
  const parts = address.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return undefined
  const bytes = parts.map(Number)
  return bytes.every((byte) => byte <= 255) ? bytes : undefined
}

function readGroups(text: string): number[] | undefined {
  if (text === '') return []
  const groups = text.split(':')
  const words: number[] = []
  for (const [i, group] of groups.entries()) {
    if (i === groups.length - 1 && group.includes('.')) {
      const v4 = parseIPv4(group)
      if (v4 === undefined) return undefined
      words.push(v4[0]! * 256 + v4[1]!, v4[2]! * 256 + v4[3]!)
    } else if (/^[0-9a-fA-F]{1,4}$/.test(group)) {
      words.push(Number.parseInt(group, 16))
    } else {
      return undefined
    }
  }
  return words
}

function parseIPv6(address: string): Bytes | undefined {
  const [head = '', tail, extra] = address.split('::')
  if (extra !== undefined) return undefined
  const left = readGroups(head)
  const right = tail === undefined ? [] : readGroups(tail)
  if (left === undefined || right === undefined) return undefined
  const missing = 8 - left.length - right.length
  if (tail === undefined ? missing !== 0 : missing < 0) return undefined
  const words = [...left, ...Array<number>(tail === undefined ? 0 : missing).fill(0), ...right]
  return words.flatMap((word) => [word >> 8, word & 0xff])
}

/** The bytes to judge: an embedded IPv4 is unwrapped, a zone (`%en0`) dropped. */
function canonicalBytes(address: string): Bytes | undefined {
  const bare = address.replace(/%.*$/, '')
  const version = isIP(bare)
  if (version === 4) return parseIPv4(bare)
  if (version !== 6) return undefined
  const bytes = parseIPv6(bare)
  if (bytes === undefined) return undefined
  const startsWith = (prefix: Bytes): boolean => prefix.every((byte, i) => bytes[i] === byte)
  if (EMBEDS_V4.some(startsWith)) return bytes.slice(12)
  return startsWith(SIX_TO_FOUR) ? bytes.slice(2, 6) : bytes
}

function inCidr(bytes: Bytes, cidr: string): boolean {
  const [base = '', prefix] = cidr.split('/')
  const baseBytes = base.includes(':') ? parseIPv6(base) : parseIPv4(base)
  let bits = Number(prefix)
  for (let i = 0; i < bytes.length && bits > 0; i += 1) {
    const mask = (0xff << (8 - Math.min(8, bits))) & 0xff
    if ((bytes[i]! & mask) !== (baseBytes![i]! & mask)) return false
    bits -= 8
  }
  return true
}

/** True for anything this module must not connect to — and for anything that is not an address. */
export function isDeniedAddress(address: string): boolean {
  const bytes = canonicalBytes(address)
  if (bytes === undefined) return true
  const ranges = bytes.length === 4 ? DENIED_V4 : DENIED_V6
  return ranges.some((cidr) => inCidr(bytes, cidr))
}

/** LinkedIn or one of its subdomains, with or without the trailing root dot. */
export function isLinkedIn(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return DENIED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

// ---------------------------------------------------------------------------------------------
// The fetcher

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>
/** Every address a name resolves to. */
export type Lookup = (hostname: string) => Promise<readonly string[]>

export interface NetDeps {
  /** `globalThis.fetch` in production. */
  readonly fetch: FetchLike
  /** `systemLookup` in production. */
  readonly lookup: Lookup
  readonly timers: Timers
  readonly now: () => Date
  /** The least time between the end of one request to a host and the start of the next. */
  readonly politeMs: number
}

export interface Page {
  readonly status: number
  /** Where the page was finally read from, after any redirects. */
  readonly url: string
  /** Every redirect target, in order. */
  readonly redirects: readonly string[]
  readonly contentType: string | null
  /** Decoded as UTF-8; invalid sequences become U+FFFD. */
  readonly body: string
}

export interface GetOptions {
  /** Lets a caller with its own deadline (a check, a paste) give up early. */
  readonly signal?: AbortSignal
}

export interface Net {
  /** Never throws for an expected failure. */
  readonly get: (url: string, options?: GetOptions) => Promise<NetResult<Page>>
}

export const systemLookup: Lookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, order: 'verbatim' })).map((entry) => entry.address)

/** Parses and judges a URL before anything about it is resolved or fetched. */
function checkUrl(raw: string, base?: URL): NetResult<URL> {
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    return fail('bad-url', `not a valid URL: ${raw}`)
  }
  if (url.protocol !== 'https:') return fail('not-https', `only https: links are fetched, not ${url.protocol}`)
  if (url.username !== '' || url.password !== '') return fail('bad-url', 'a URL with credentials is not fetched')
  // `URL` drops the default `:443`, so any port left is another service: a web page never needs one.
  if (url.port !== '') return fail('bad-url', `only the default https port is fetched, not ${url.port}`)
  if (isLinkedIn(url.hostname)) return fail('linkedin', 'LinkedIn pages are never fetched — paste the ad text instead')
  return ok(url)
}

type Step = { readonly kind: 'redirect'; readonly location: string } | ({ readonly kind: 'page' } & Omit<Page, 'url' | 'redirects'>)

export function createNet(deps: NetDeps): Net {
  const { fetch, lookup, timers, now, politeMs } = deps

  const sleep = (ms: number): Promise<void> =>
    ms <= 0 ? Promise.resolve() : new Promise((resolve) => void timers.setTimeout(resolve, ms))

  /**
   * One request at a time per host, `politeMs` after the previous one ENDED. Each host keeps the
   * promise of its last turn; the map grows by one small entry per host ever visited.
   */
  const lastTurn = new Map<string, Promise<number>>()
  async function courtesy<T>(host: string, work: () => Promise<T>): Promise<T> {
    const previous = lastTurn.get(host)
    let release: (endedAt: number) => void = () => undefined
    lastTurn.set(host, new Promise((resolve) => (release = resolve)))
    try {
      if (previous !== undefined) await sleep((await previous) + politeMs - now().getTime())
      return await work()
    } finally {
      release(now().getTime())
    }
  }

  async function checkHost(hostname: string): Promise<NetResult<void>> {
    const host = hostname.replace(/^\[(.*)\]$/, '$1')
    let addresses: readonly string[]
    if (isIP(host) !== 0) {
      addresses = [host]
    } else {
      try {
        addresses = await lookup(host)
      } catch (error) {
        return fail('dns', `could not resolve ${host}: ${describe(error)}`)
      }
    }
    if (addresses.length === 0) return fail('dns', `${host} resolves to no address`)
    const denied = addresses.find(isDeniedAddress)
    if (denied !== undefined) return fail('private-address', `${host} resolves to a private address (${denied})`)
    return ok(undefined)
  }

  /** Runs `work` under the `TIMEOUT_MS` deadline and the caller's signal, whichever ends first. */
  async function withDeadline<T>(work: (signal: AbortSignal) => Promise<NetResult<T>>, outer?: AbortSignal): Promise<NetResult<T>> {
    if (outer?.aborted) return fail('aborted', 'the request was cancelled')
    const controller = new AbortController()
    let timedOut = false
    const timer = timers.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, TIMEOUT_MS)
    const onOuterAbort = (): void => controller.abort()
    outer?.addEventListener('abort', onOuterAbort, { once: true })
    const stopped = new Promise<NetResult<T>>((resolve) => {
      controller.signal.addEventListener('abort', () =>
        resolve(timedOut ? fail('timeout', `no answer within ${TIMEOUT_MS / 1000} s`) : fail('aborted', 'the request was cancelled')),
      )
    })
    try {
      return await Promise.race([work(controller.signal), stopped])
    } finally {
      timer[Symbol.dispose]()
      outer?.removeEventListener('abort', onOuterAbort)
    }
  }

  async function fetchOnce(url: URL, signal: AbortSignal): Promise<NetResult<Step>> {
    const allowed = await checkHost(url.hostname)
    if (!allowed.ok) return allowed
    let response: Response
    try {
      response = await fetch(url.href, { method: 'GET', headers: { 'user-agent': USER_AGENT }, redirect: 'manual', signal })
    } catch (error) {
      return fail('network', `could not fetch ${url.host}: ${describe(error)}`)
    }
    const location = response.headers.get('location')
    if (REDIRECT_STATUSES.has(response.status) && location !== null) {
      // The redirect's own body is never wanted; cancelling it frees the connection.
      await response.body?.cancel().catch(() => undefined)
      return ok({ kind: 'redirect', location })
    }
    const body = await readCapped(response)
    if (!body.ok) return body
    return ok({ kind: 'page', status: response.status, contentType: response.headers.get('content-type'), body: body.value })
  }

  async function follow(url: URL, redirects: readonly string[], options: GetOptions): Promise<NetResult<Page>> {
    const step = await courtesy(url.hostname, () => withDeadline((signal) => fetchOnce(url, signal), options.signal))
    if (!step.ok) return step
    if (step.value.kind === 'page') {
      const { kind: _kind, ...page } = step.value
      return ok({ ...page, url: url.href, redirects })
    }
    if (redirects.length === MAX_REDIRECTS) return fail('too-many-redirects', `more than ${MAX_REDIRECTS} redirects`)
    const next = checkUrl(step.value.location, url)
    if (!next.ok) return next
    return follow(next.value, [...redirects, next.value.href], options)
  }

  return {
    get: async (raw, options = {}) => {
      const url = checkUrl(raw)
      return url.ok ? follow(url.value, [], options) : url
    },
  }
}

/** Reads at most `BODY_CAP_BYTES`, stopping the stream as soon as it would go over. */
async function readCapped(response: Response): Promise<NetResult<string>> {
  const tooLarge = fail('too-large', `the page is larger than ${BODY_CAP_BYTES / (1024 * 1024)} MiB`)
  const declared = Number(response.headers.get('content-length'))
  if (declared > BODY_CAP_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return tooLarge
  }
  if (response.body === null) return ok('')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      size += read.value.byteLength
      if (size > BODY_CAP_BYTES) {
        await reader.cancel()
        return tooLarge
      }
      chunks.push(read.value)
    }
  } catch (error) {
    return fail('network', `the page stopped arriving: ${describe(error)}`)
  }
  return ok(Buffer.concat(chunks, size).toString('utf8'))
}
