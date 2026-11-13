/**
 * The address search (task N2, design D9 «La re-búsqueda de la dirección»; requirements crit. 45, 46).
 *
 * Only the company's own domain — the host of its `website`, without `www.` — and its subdomains:
 * the home page, then at most `MAX_EXTRA_PAGES` pages whose link text or path says
 * `contact|careers|jobs|about|team|join`. The address counts when it appears LITERALLY (or written
 * `[at]` / ` at `, or behind an HTML entity) in a page or in a `mailto:` link.
 *
 * Everything goes out through the injected `Net` (`scout/net.ts`): no test touches the network, and
 * the SSRF guard, the courtesy per host and the 20 s per request are net's.
 *
 * THE RESULT BELONGS TO THE CONTACT (v4, A2): found → `verified` with `verifiedUrl` (T-D3); not found,
 * no website or no network → `unverified` with `checkedAt` (T-D4), «couldn't check». The transition
 * is `addressTransition`'s; this file only searches and stores.
 */

import type { NetFailure, Net, Page } from '../scout/net.ts'
import { addressTransition } from '../state.ts'
import type { Db, Queries } from '../store/db.ts'
import { getCompany, getContact, saveContact } from '../store/repo.ts'
import { fail, ok, type Contact, type Result } from '../types.ts'

/** Pages searched after the home page, at most. */
export const MAX_EXTRA_PAGES = 6

const PAGE_WORDS = /contact|careers|jobs|about|team|join/i

export interface AddressTarget {
  readonly email: string
  /** The company's `website`; null when it has none. */
  readonly website: string | null
}

export type AddressOutcome =
  | { readonly kind: 'found'; readonly url: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'no-website' }
  /** «couldn't check»: the home page could not be read (`reason` is net's failure or `http-<status>`). */
  | { readonly kind: 'unreachable'; readonly reason: NetFailure | `http-${number}` | 'error' }
  /** The check queue's deadline (`CHECK_DEADLINE_MS`, N4) ran out first. */
  | { readonly kind: 'timed-out' }

export type AddressSearch = (target: AddressTarget, signal?: AbortSignal) => Promise<AddressOutcome>

// ── Reading a page ───────────────────────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Readonly<Record<string, string>> = { commat: '@', period: '.', amp: '&', nbsp: ' ', quot: '"', apos: "'" }

const MAX_CODE_POINT = 0x10ffff
const isSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdfff

/** A character reference's character; the reference itself when it names none (`String.fromCodePoint` would throw). */
function charOf(code: number, whole: string): string {
  return code > MAX_CODE_POINT || isSurrogate(code) ? whole : String.fromCodePoint(code)
}

function decodeEntities(html: string): string {
  return html.replace(/&#(\d+);|&#x([0-9a-f]+);|&([a-z]+);/gi, (whole, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined) return charOf(Number(dec), whole)
    if (hex !== undefined) return charOf(Number.parseInt(hex, 16), whole)
    return NAMED_ENTITIES[(name ?? '').toLowerCase()] ?? whole
  })
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

// LINEAR TIME ONLY. A page is up to 1 MiB of a stranger's HTML and a regex runs synchronously: the
// check's 60 s deadline cannot interrupt it, so a backtracking pattern (`<[^>]*>` on `<<<<…`,
// `\s*…` on a long run of spaces, `([\s\S]*?)<\/a>` on anchors that never close) would freeze the
// daemon for minutes. Tags are walked with `indexOf`, and the regexes left run on bounded text.

/** A `<` further than this from its `>` is text, not a tag. */
export const MAX_TAG_LENGTH = 500

type Token = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'tag'; readonly tag: string }

/** The page as text and tags, in order, in one pass: the next `>` is looked up again only once passed. */
function tokenize(html: string): readonly Token[] {
  const tokens: Token[] = []
  let textFrom = 0
  let gt = -1
  for (let lt = html.indexOf('<'); lt !== -1; lt = html.indexOf('<', lt + 1)) {
    if (gt < lt) gt = html.indexOf('>', lt)
    if (gt === -1) break // no `>` left: the rest is text
    if (gt - lt > MAX_TAG_LENGTH) continue
    if (lt > textFrom) tokens.push({ kind: 'text', text: html.slice(textFrom, lt) })
    tokens.push({ kind: 'tag', tag: html.slice(lt, gt + 1) })
    textFrom = gt + 1
    lt = gt
  }
  if (textFrom < html.length) tokens.push({ kind: 'text', text: html.slice(textFrom) })
  return tokens
}

/** Every tag becomes a space, as a browser would separate the words. */
const textOf = (tokens: readonly Token[]): string => tokens.map((token) => (token.kind === 'text' ? token.text : ' ')).join('')

/** `ada [at] acme`, `ada(at)acme`, `ada at acme` → `ada@acme`, on whitespace already collapsed to one space. */
const deobfuscate = (text: string): string => text.replace(/\s+/g, ' ').replace(/ ?[[(] ?at ?[\])] ?| at /gi, '@')

/** Every place the address may be written: the page, its text de-obfuscated, its `mailto:` links. */
function haystacks(body: string): readonly string[] {
  const decoded = decodeEntities(body)
  const mailtos = [...decoded.matchAll(/mailto:([^"'?\s>]+)/gi)].map((match) => safeDecode(match[1] ?? ''))
  return [decoded, deobfuscate(textOf(tokenize(decoded))), ...mailtos]
}

/** The quoted `href` of an opening `<a …>` tag (at most `MAX_TAG_LENGTH` long), or null. */
function hrefOf(tag: string): string | null {
  if (!/^<a[\s>]/i.test(tag)) return null
  const at = /\shref\s*=\s*/i.exec(tag)
  if (at === null) return null
  const start = at.index + at[0].length
  const quote = tag[start]
  if (quote !== '"' && quote !== "'") return null
  const end = tag.indexOf(quote, start + 1)
  return end === -1 ? null : tag.slice(start + 1, end)
}

const isAnchorEnd = (tag: string): boolean => /^<\/a[\s>]/i.test(tag)

interface Anchor {
  readonly href: string
  readonly text: string
}

/** Each `<a href>` with its text, which ends at its `</a>` or at the next anchor (they do not nest). */
function anchorsOf(body: string): readonly Anchor[] {
  const anchors: Anchor[] = []
  let href: string | null = null
  let parts: string[] = []
  for (const token of [...tokenize(body), { kind: 'tag', tag: '</a>' } as const]) {
    if (token.kind === 'text') {
      if (href !== null) parts.push(token.text)
      continue
    }
    const opened = hrefOf(token.tag)
    if (href !== null && (opened !== null || isAnchorEnd(token.tag))) anchors.push({ href, text: parts.join(' ') })
    if (opened !== null || isAnchorEnd(token.tag)) {
      href = opened
      parts = []
    }
  }
  return anchors
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The address as a whole token: `lada@…` or `…example.au` is a different address. */
function mentions(body: string, email: string): boolean {
  const pattern = new RegExp(`(?<![\\w.%+-])${escapeRegExp(email)}(?![\\w-]|\\.\\w)`, 'i')
  return haystacks(body).some((haystack) => pattern.test(haystack))
}

const onDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

/** An `href` resolved against the page, without its fragment; null when it is not a URL. */
function absoluteUrl(href: string, base: string): URL | null {
  try {
    const url = new URL(decodeEntities(href), base)
    url.hash = ''
    return url
  } catch {
    return null
  }
}

/** The links worth a visit, in document order, deduplicated, on the domain, `https:` only. */
function candidatePages(page: Page, domain: string): readonly string[] {
  const seen = new Set<string>([page.url])
  const found: string[] = []
  // Parsing a URL is the costly step: a page repeating one href is parsed once.
  const resolved = new Map<string, URL | null>()
  const resolve = (href: string): URL | null => {
    if (!resolved.has(href)) resolved.set(href, absoluteUrl(href, page.url))
    return resolved.get(href) ?? null
  }
  for (const anchor of anchorsOf(page.body)) {
    const url = resolve(anchor.href)
    if (url === null) continue
    const wanted = PAGE_WORDS.test(url.pathname) || PAGE_WORDS.test(anchor.text)
    if (!wanted || url.protocol !== 'https:' || !onDomain(url.hostname, domain) || seen.has(url.href)) continue
    seen.add(url.href)
    found.push(url.href)
    if (found.length === MAX_EXTRA_PAGES) break
  }
  return found
}

function homeOf(website: string | null): URL | null {
  if (website === null || website.trim() === '') return null
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : `https://${website}`
  try {
    const url = new URL(raw)
    if (url.protocol === 'http:') url.protocol = 'https:'
    return url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

const isSuccess = (page: Page): boolean => page.status >= 200 && page.status < 300

// ── The search ───────────────────────────────────────────────────────────────────────────────────

/** Never throws: every failure is an outcome. */
export async function searchAddress(net: Net, target: AddressTarget, signal?: AbortSignal): Promise<AddressOutcome> {
  const home = homeOf(target.website)
  if (home === null) return { kind: 'no-website' }
  const domain = home.hostname.toLowerCase().replace(/^www\./, '')
  const options = signal === undefined ? {} : { signal }

  const first = await net.get(home.href, options)
  if (!first.ok) return { kind: 'unreachable', reason: first.error.kind }
  if (!isSuccess(first.value)) return { kind: 'unreachable', reason: `http-${first.value.status}` }
  if (!onDomain(new URL(first.value.url).hostname, domain)) return { kind: 'not-found' }
  if (mentions(first.value.body, target.email)) return { kind: 'found', url: first.value.url }

  for (const url of candidatePages(first.value, domain)) {
    if (signal?.aborted === true) return { kind: 'unreachable', reason: 'aborted' }
    const next = await net.get(url, options)
    if (!next.ok || !isSuccess(next.value) || !onDomain(new URL(next.value.url).hostname, domain)) continue
    if (mentions(next.value.body, target.email)) return { kind: 'found', url: next.value.url }
  }
  return { kind: 'not-found' }
}

export const addressSearch =
  (net: Net): AddressSearch =>
  (target, signal) =>
    searchAddress(net, target, signal)

// ── Storing the result ───────────────────────────────────────────────────────────────────────────

function eventData(outcome: AddressOutcome): Readonly<Record<string, unknown>> {
  switch (outcome.kind) {
    case 'found':
      return { found: true, url: outcome.url }
    case 'unreachable':
      return { found: false, reason: 'unreachable', detail: outcome.reason }
    case 'timed-out':
      return { found: false, reason: 'timed-out', timedOut: true }
    default:
      return { found: false, reason: outcome.kind }
  }
}

/** T-D3 / T-D4 on a contact in `checking`, with its `address-checked` event, in the caller's `tx`. */
export function applyAddressOutcome(q: Queries, contactId: string, outcome: AddressOutcome, now: Date): Result<Contact> {
  const contact = getContact(q, contactId)
  if (contact === undefined) return fail('not-found', 'no such contact')
  const event = outcome.kind === 'found' ? { type: 'check-found' as const, url: outcome.url } : { type: 'check-missed' as const, timedOut: outcome.kind === 'timed-out' }
  const moved = addressTransition(contact, event, now)
  if (!moved.ok) return moved
  saveContact(q, moved.value, { kind: 'address-checked', data: eventData(outcome) }, now)
  return ok(moved.value)
}

export interface CheckAddressDeps {
  readonly db: Db
  readonly search: AddressSearch
  readonly now: () => Date
}

/**
 * Searches the address of a contact in `checking` and writes the result. The network runs OUTSIDE any
 * `tx`. Once `signal` is aborted (the queue's deadline), nothing is written: the deadline writes its own
 * `timed-out`, and a late answer must not overwrite a later check.
 */
export async function checkAddress(deps: CheckAddressDeps, contactId: string, signal?: AbortSignal): Promise<Result<Contact>> {
  const found = deps.db.read((q) => {
    const contact = getContact(q, contactId)
    return contact === undefined ? undefined : { contact, website: getCompany(q, contact.companyId)?.website ?? null }
  })
  if (found === undefined) return fail('not-found', 'no such contact')
  const { contact, website } = found
  if (contact.address === null || contact.email === null) return fail('conflict', 'the contact has no address')
  if (contact.address.status !== 'checking') return fail('conflict', `the address is ${contact.address.status}, not checking`)

  let outcome: AddressOutcome
  try {
    outcome = await deps.search({ email: contact.email, website }, signal)
  } catch {
    outcome = { kind: 'unreachable', reason: 'error' }
  }
  if (signal?.aborted === true) return fail('conflict', 'cancelled')
  return deps.db.tx((q) => applyAddressOutcome(q, contactId, outcome, deps.now()))
}
