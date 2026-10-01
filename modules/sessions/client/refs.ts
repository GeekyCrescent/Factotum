/**
 * References to the project's files, typed as `@` in the box. PURE: no DOM, no fetch (spec
 * 2026-10-01-referencias-y-tab, D7).
 *
 * THE SENT TEXT IS THE ONLY RECORD, as it is for attachments. A reference is text — `@src/app.ts`,
 * `@docs/`, `@"docs/mi nota.md"` — and the CLI embeds the file it names without a tool (measured,
 * requirements §0.1). Everything here either writes that text or reads it back.
 *
 * TWO QUOTING RULES, and they are not the same one:
 *  - what is INSERTED is always closed (`refText`): `@"Por hacer.md"`;
 *  - a token rewritten while NAVIGATING stays open (`tokenText`): `@"00 inbox/`, so `tokenAt` still
 *    reads it as one token with the caret at its end.
 */

import type { Listing, ListingEntry } from '../types.ts'

// ---------------------------------------------------------------------------
// Whether this host lists files (criterion 17)
// ---------------------------------------------------------------------------

export type FilesState = { readonly kind: 'on'; readonly maxEntries: number } | { readonly kind: 'old' }

/** Read AS DATA: a daemon from before references sends no `files`, and then `@` is plain text. */
export function filesOf(setup: unknown): FilesState {
  const files = (setup as { files?: unknown } | null | undefined)?.files
  const maxEntries = (files as { maxEntries?: unknown } | null | undefined)?.maxEntries
  return typeof maxEntries === 'number' && maxEntries > 0 ? { kind: 'on', maxEntries } : { kind: 'old' }
}

// ---------------------------------------------------------------------------
// The token under the caret (criteria 18, 20)
// ---------------------------------------------------------------------------

/** «Blank»: the same word here and in `inlineRefs`. The start of the text counts as one. */
const BLANK = /\s/

export interface Token {
  /** Where the `@` is. */
  readonly start: number
  /** Unquoted: the end of the run the caret is in. Quoted: THE CARET, never beyond. */
  readonly end: number
  readonly quoted: boolean
  /** What follows the `@` (and the opening quote) up to the caret. */
  readonly query: string
}

/**
 * The `@…` being written at the caret. Only on the caret's line, and the CLOSEST `@` that makes a
 * valid token wins. A quoted token takes spaces but ends at the caret, so inserting never eats what
 * the owner wrote after it; one whose quote is already closed is a finished reference.
 */
export function tokenAt(text: string, caret: number): Token | undefined {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  for (let at = caret - 1; at >= lineStart; at -= 1) {
    if (text[at] !== '@' || (at > 0 && !BLANK.test(text[at - 1] as string))) continue
    const quoted = text[at + 1] === '"' && caret > at + 1
    const query = text.slice(at + (quoted ? 2 : 1), caret)
    if (quoted) {
      if (!query.includes('"')) return { start: at, end: caret, quoted: true, query }
      continue
    }
    if (BLANK.test(query) || query.includes('"')) continue
    let end = caret
    while (end < text.length && !BLANK.test(text[end] as string)) end += 1
    return { start: at, end, quoted: false, query }
  }
  return undefined
}

/**
 * The folder a query means, and the prefix to filter it by. `undefined`: ask for nothing — never a
 * path the module would refuse (`..`, `.`, an empty segment, the disk's root).
 */
export function requestOf(query: string, rootPath: string): { readonly dir: string | undefined; readonly prefix: string } | undefined {
  const slash = query.lastIndexOf('/')
  const folder = slash < 0 ? '' : query.slice(0, slash)
  const prefix = query.slice(slash + 1)
  const absolute = query.startsWith('/')
  const segments = absolute ? folder.split('/').slice(1) : folder === '' ? [] : folder.split('/')
  if (absolute && segments.length === 0) return undefined
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined
  if (absolute) return { dir: folder, prefix }
  return { dir: folder === '' ? undefined : `${rootPath}/${folder}`, prefix }
}

// ---------------------------------------------------------------------------
// What is inserted (criterion 23)
// ---------------------------------------------------------------------------

/** The rule `refText` and `inlineRefs` share: a name, then a dot and one to eight letters or digits. */
export function hasPlainExtension(name: string): boolean {
  return /^[^.\s]\S*\.[A-Za-z0-9]{1,8}$/.test(name)
}

const UNREFERENCEABLE = /["\r\n]/

export type RefTarget = ListingEntry | { readonly kind: 'this-dir' } | { readonly kind: 'shared'; readonly path: string }

/**
 * The text an entry becomes, ALWAYS CLOSED. Relative to the project, absolute inside a shared folder;
 * a folder ends in `/`. In quotes when it has a blank or is a file without a plain extension, so the
 * bubble always knows it again. `undefined`: the CLI could not read it (a quote or a line break in it).
 */
export function refText(listing: Pick<Listing, 'root' | 'dir'>, target: RefTarget): string | undefined {
  const path = target.kind === 'shared' ? target.path : target.kind === 'this-dir' ? listing.dir : joinPath(listing.dir, target.name)
  const relative = target.kind !== 'shared' && listing.root.kind === 'site'
  const text = relative ? path.slice(listing.root.path.length + 1) : path
  if (text === '' || UNREFERENCEABLE.test(text)) return undefined
  const isFile = target.kind === 'file'
  const written = isFile ? text : `${text}/`
  const quote = BLANK.test(written) || (isFile && !hasPlainExtension(lastSegment(written)))
  return quote ? `@"${written}"` : `@${written}`
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

function lastSegment(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

// ---------------------------------------------------------------------------
// Tab, and rewriting a token while navigating (criterion 20)
// ---------------------------------------------------------------------------

const fold = (text: string): string => text.normalize('NFC').toLowerCase()

export type Completion =
  /** One match, a file: insert it closed, as Enter would. */
  | { readonly kind: 'insert'; readonly entry: ListingEntry }
  /** One match, a folder: go into it. */
  | { readonly kind: 'enter'; readonly name: string }
  /** Several: the longer prefix they share. */
  | { readonly kind: 'extend'; readonly text: string }

export function completion(prefix: string, entries: readonly ListingEntry[]): Completion | undefined {
  const wanted = fold(prefix)
  const matches = entries.filter((entry) => fold(entry.name).startsWith(wanted))
  const [only] = matches
  if (only === undefined) return undefined
  if (matches.length === 1) return only.kind === 'file' ? { kind: 'insert', entry: only } : { kind: 'enter', name: only.name }
  let length = only.name.length
  for (const entry of matches) {
    let i = 0
    while (i < length && i < entry.name.length && fold(entry.name[i] as string) === fold(only.name[i] as string)) i += 1
    length = i
  }
  const shared = only.name.slice(0, length)
  return shared.length > prefix.length ? { kind: 'extend', text: shared } : undefined
}

/** What Tab does to a token: insert a reference, closed; rewrite the query, open; or nothing. */
export type TabResult = { readonly kind: 'insert'; readonly text: string } | { readonly kind: 'rewrite'; readonly query: string } | undefined

/**
 * Tab over a listing, for the query being typed. The shared folders at the project's top count as
 * folders: entering one jumps to its absolute path (found in the browser, 2026-10-01: without them,
 * `@fac` + Tab did nothing).
 */
export function tabOf(listing: Listing, query: string): TabResult {
  const folder = query.slice(0, query.lastIndexOf('/') + 1)
  const shared = listing.shared.map((item): ListingEntry => ({ name: item.name, kind: 'dir' }))
  const done = completion(query.slice(folder.length), [...listing.entries, ...shared])
  if (done === undefined) return undefined
  if (done.kind === 'insert') {
    const text = refText(listing, done.entry)
    return text === undefined ? undefined : { kind: 'insert', text }
  }
  if (done.kind === 'extend') return { kind: 'rewrite', query: `${folder}${done.text}` }
  const isEntry = listing.entries.some((item) => item.kind === 'dir' && item.name === done.name)
  const into = isEntry ? undefined : listing.shared.find((item) => item.name === done.name)
  return { kind: 'rewrite', query: into === undefined ? `${folder}${done.name}/` : `${into.path}/` }
}

/**
 * A token the box rewrites WITHOUT closing it: Tab that enters or extends, «..», a tap on a folder.
 * Once quoted it stays quoted until it is inserted: dropping the quote halfway would split it.
 */
export function tokenText(path: string, quoted: boolean): string {
  return quoted || BLANK.test(path) ? `@"${path}` : `@${path}`
}

// ---------------------------------------------------------------------------
// Reading the sent text back (criterion 29)
// ---------------------------------------------------------------------------

export type InlinePiece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'ref'; readonly raw: string; readonly name: string; readonly dir: boolean }

/** An `@` after a blank, then a closed quote or a run of non-blanks. */
const CANDIDATE = /(^|\s)@("[^"\n]+"|\S+)/g
const TRAILING = /[,;:!?).]+$/

/**
 * The owner's words with the references picked out. ONLY the three shapes `refText` writes — quoted,
 * ending in `/`, or a last segment with a plain extension — so `@factotum/core` and `@types/node`
 * stay text. Applied only to the text pieces `splitRefs` leaves, never to an attachment's line.
 */
export function inlineRefs(text: string): readonly InlinePiece[] {
  const pieces: InlinePiece[] = []
  let from = 0
  for (const match of text.matchAll(CANDIDATE)) {
    const [, blank = '', body = ''] = match
    const start = (match.index ?? 0) + blank.length
    // A quote that never closes is not a reference, whatever follows it.
    const quoted = /^"[^"\n]+"$/.test(body)
    if (body.startsWith('"') && !quoted) continue
    const raw = quoted ? body : body.replace(TRAILING, '')
    const inner = quoted ? raw.slice(1, -1) : raw
    const dir = inner.endsWith('/')
    const name = lastSegment(inner)
    const isRef = name !== '' && (quoted || dir || hasPlainExtension(name))
    if (!isRef) continue
    if (start > from) pieces.push({ kind: 'text', text: text.slice(from, start) })
    pieces.push({ kind: 'ref', raw: `@${raw}`, name, dir })
    from = start + 1 + raw.length
  }
  if (from < text.length) pieces.push({ kind: 'text', text: text.slice(from) })
  return pieces
}

// ---------------------------------------------------------------------------
// Requests, and what a failed one says (criteria 25, 26)
// ---------------------------------------------------------------------------

/** Last one wins: a response is used only if no request went out after it. */
export function latest(): { readonly next: () => number; readonly isLatest: (n: number) => boolean } {
  let current = 0
  return {
    next: () => {
      current += 1
      return current
    },
    isLatest: (n) => n === current,
  }
}

/** One line for a listing that failed. Never touches the box's text. */
export function pickerErrorText(cause: unknown): string {
  const failure = cause as { status?: unknown; body?: { missing?: unknown; files?: { unreadable?: unknown; timeout?: unknown } } } | null
  const status = typeof failure?.status === 'number' ? failure.status : 0
  const body = failure?.body
  if (status === 409 && body?.missing !== undefined) return 'The project folder is missing.'
  if (status === 409 && body?.files?.unreadable === true) return 'Factotum cannot read that folder.'
  if (status === 409 && body?.files?.timeout === true) return 'That folder is taking too long to read.'
  if (status === 404) return 'That folder is no longer there.'
  if (status === 0 || status === 502 || status === 503 || status === 504) return 'Could not reach Factotum.'
  if (status === 400) return 'That path cannot be listed.'
  return `Could not list that folder (${status}).`
}
