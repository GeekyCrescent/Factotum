/**
 * The manifest of one project (spec 2026-10-07-dos-hosts, D8): every file that goes, with its size and
 * its `sha256`, and the project's `git bundle` among them. The source builds it; the target checks it
 * with `validateManifest`, PURE, before writing anything (criterion 30d).
 *
 * WHAT THE TARGET LETS THE SOURCE WRITE IS DECIDED HERE: a closed list of kinds, each with ONE fixed
 * shape of `rel`, inside `staging/<sessionId>/` and nowhere else, for sessions `prepare` already
 * checked. A path of the source never travels — the target names everything itself.
 *
 * (Called `bundle.ts` until the v4, when the code started travelling in a real `git bundle`.)
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { resolve, sep } from 'node:path'
import { isSessionId } from '../id.ts'
import { isSanitizedName } from '../uploads/name.ts'
import type { FileKind, LocalFile } from './files.ts'

/**
 * At most this many entries (requirements §8, v4.3, «Para el implementador»). Measured on the Mac on
 * 2026-10-14: the largest transcript folder holds 271 files, and an entry is ~320 bytes of JSON, so
 * MAX_BODY_BYTES (1 MiB) takes ~3 200. The source also checks the serialized size before sending.
 */
export const HANDOFF_MANIFEST_MAX_ENTRIES = 3_000

export const FILE_KINDS: readonly FileKind[] = ['meta', 'events', 'upload', 'transcript', 'transcript-dir-file', 'git-bundle']

export interface ManifestEntry {
  readonly n: number
  readonly sessionId?: string
  readonly kind: FileKind
  readonly rel: string
  readonly bytes: number
  readonly sha256: string
}

export interface BuiltManifest {
  readonly entries: readonly ManifestEntry[]
  /** Where each `n` is on THIS host. Never sent. */
  readonly sources: ReadonlyMap<number, string>
}

/** Hashes in a stream: a 100 MB transcript is never held whole (criterion 33). */
export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** The bundle first (`n` = 0): a `bundle-base-missing` arrives before any transcript travels (D8, step 3). */
export async function buildManifest(files: readonly LocalFile[], bundle: { readonly abs: string; readonly bytes: number } | undefined): Promise<BuiltManifest> {
  const entries: ManifestEntry[] = []
  const sources = new Map<number, string>()
  if (bundle !== undefined) {
    entries.push({ n: 0, kind: 'git-bundle', rel: 'code.bundle', bytes: bundle.bytes, sha256: await sha256Of(bundle.abs) })
    sources.set(0, bundle.abs)
  }
  for (const file of files) {
    const n = entries.length
    const base = { n, kind: file.kind, rel: file.rel, bytes: file.bytes, sha256: await sha256Of(file.abs) }
    entries.push(file.sessionId === undefined ? base : { ...base, sessionId: file.sessionId })
    sources.set(n, file.abs)
  }
  return { entries, sources }
}

export type Validated = { readonly ok: true; readonly entries: readonly ManifestEntry[] } | { readonly ok: false; readonly message: string }

const SHA256 = /^[0-9a-f]{64}$/
/** Where the files land, as a path the check can compare: never written anywhere. */
const STAGING = resolve('/staging')

/** The one shape of `rel` for each kind (D8's table). */
function relFits(entry: ManifestEntry): boolean {
  const { kind, rel, sessionId } = entry
  switch (kind) {
    case 'meta':
      return rel === 'session/meta.json'
    case 'events':
      return rel === 'session/events.jsonl'
    case 'upload': {
      const parts = rel.split('/')
      return parts.length === 3 && parts[0] === 'uploads' && isSessionId(parts[1] ?? '') && isSanitizedName(parts[2] ?? '')
    }
    case 'transcript':
      return rel === `cli/${sessionId}.jsonl`
    case 'transcript-dir-file': {
      const prefix = `cli/${sessionId}/`
      if (!rel.startsWith(prefix)) return false
      return rel
        .slice(prefix.length)
        .split('/')
        .every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('\\') && !segment.includes('\u0000'))
    }
    case 'git-bundle':
      return rel === 'code.bundle'
  }
}

/** Where the entry would be written, resolved; and whether that is inside its own folder. */
function staysInside(entry: ManifestEntry): string | undefined {
  if (entry.kind === 'git-bundle') return resolve(STAGING, entry.rel) === resolve(STAGING, 'code.bundle') ? resolve(STAGING, 'code.bundle') : undefined
  const own = resolve(STAGING, entry.sessionId ?? '')
  const target = resolve(own, entry.rel)
  return target.startsWith(own + sep) ? target : undefined
}

function shapeOf(value: unknown, maxBytes: number): ManifestEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const { n, kind, rel, bytes, sha256, sessionId } = raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return undefined
  if (typeof kind !== 'string' || !(FILE_KINDS as readonly string[]).includes(kind)) return undefined
  if (typeof rel !== 'string' || typeof sha256 !== 'string' || !SHA256.test(sha256)) return undefined
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0 || bytes > maxBytes) return undefined
  if (sessionId !== undefined && typeof sessionId !== 'string') return undefined
  const base = { n, kind: kind as FileKind, rel, bytes, sha256 }
  return sessionId === undefined ? base : { ...base, sessionId }
}

/**
 * The target's check of a manifest, BEFORE writing anything (D8, criterion 30d). `sessionIds` are the
 * ones `prepare` brought, which the journal keeps (v4.2): the source cannot slip in a session nobody
 * checked for `target-busy` or `history-diverged`.
 */
export function validateManifest(value: unknown, sessionIds: readonly string[], maxBytes: number): Validated {
  const no = (message: string): Validated => ({ ok: false, message })
  if (!Array.isArray(value)) return no('a manifest is a list of files')
  if (value.length > HANDOFF_MANIFEST_MAX_ENTRIES) return no(`a manifest holds at most ${HANDOFF_MANIFEST_MAX_ENTRIES} files`)
  const entries: ManifestEntry[] = []
  for (const raw of value) {
    const entry = shapeOf(raw, maxBytes)
    if (entry === undefined) return no('a manifest entry is not well formed')
    entries.push(entry)
  }

  const numbers = new Set(entries.map((entry) => entry.n))
  if (numbers.size !== entries.length || entries.some((entry) => entry.n >= entries.length)) return no('the files are numbered 0…k−1, each once')
  if (entries.filter((entry) => entry.kind === 'git-bundle').length > 1) return no('a project has at most one git bundle')

  const destinations = new Set<string>()
  const perSession = new Map<string, { meta: number; events: number }>()
  for (const entry of entries) {
    if (entry.kind === 'git-bundle') {
      if (entry.sessionId !== undefined) return no('the git bundle belongs to the project, not to a session')
    } else {
      if (entry.sessionId === undefined || !isSessionId(entry.sessionId)) return no('every file but the git bundle names its session')
      if (!sessionIds.includes(entry.sessionId)) return no('a file of a session that prepare did not bring')
      const counts = perSession.get(entry.sessionId) ?? { meta: 0, events: 0 }
      perSession.set(entry.sessionId, { meta: counts.meta + (entry.kind === 'meta' ? 1 : 0), events: counts.events + (entry.kind === 'events' ? 1 : 0) })
    }
    if (!relFits(entry)) return no(`a ${entry.kind} is not where its kind goes`)
    const destination = staysInside(entry)
    if (destination === undefined) return no('a file would land outside its folder')
    if (destinations.has(destination)) return no('two files would land in one place')
    destinations.add(destination)
  }
  for (const counts of perSession.values()) {
    if (counts.meta !== 1 || counts.events !== 1) return no('every session brings exactly one meta and one log')
  }
  return { ok: true, entries }
}
