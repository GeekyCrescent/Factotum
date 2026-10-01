/**
 * Listing ONE folder for an `@` reference (spec 2026-10-01-referencias-y-tab, D1–D4). Read only:
 * names and kinds, never a file's bytes, size or date.
 *
 * IT IS A LISTING OF THE DISK ASKED FOR OVER THE NETWORK, and the agent can already read anything
 * (the gate only watches writes). So the boundary is the gate's own — the project's folder and the
 * shared folders — and it is decided on the REAL path, after links are resolved. Outside, hidden,
 * absent and not-a-folder are one answer, so a request cannot ask what is on the disk beyond it.
 *
 * The FORM of `dir` (absolute, no `.` or `..`, normalised) is the module's, like every path (D1).
 * Nothing here depends on it for safety: `contains` normalises, and the real path is what decides.
 */

import { opendir, realpath, stat } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import type { Timers } from '@factotum/core'
import { bounded } from './bounded.ts'
import { contains, insideSite, type Site, type SiteCheck } from './sites.ts'
import type { FilesQuery, FilesResult, Listing, ListingEntry, SharedView } from './types.ts'

/** Never listed, never entered, whatever the prefix or the case (criterion 9). Lower case. */
export const ALWAYS_HIDDEN: ReadonlySet<string> = new Set(['.git', 'node_modules', '.next', 'dist', '.ds_store'])

/**
 * WITHOUT CASE, ALWAYS. The Mac's disk ignores it, so `NODE_MODULES/x` is `node_modules/x` and must
 * stay as hidden. On a disk that does not, hiding `Dist` too costs one unlikely folder.
 */
export function isHidden(name: string): boolean {
  return ALWAYS_HIDDEN.has(name.toLowerCase())
}

export const MAX_ENTRIES = 200
/** How many names one read keeps before it stops: a guard against a folder of a million, not a page. */
export const MAX_SCAN = 10_000
export const LIST_TIMEOUT_MS = 5_000
/** Links are resolved this many at a time. */
const LINK_BATCH = 32

const CANNOT_READ = 'cannot read that folder'

/** Not `DiskProbe`: that name is taken by `sites.ts` with another shape. Injected so a test can hang it. */
export interface ListingDisk {
  readonly realpath: (path: string) => Promise<string>
  readonly opendir: (path: string) => Promise<AsyncIterable<DirentLike>>
  readonly stat: (path: string) => Promise<{ isFile(): boolean; isDirectory(): boolean }>
}

interface DirentLike {
  readonly name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

const realListingDisk: ListingDisk = {
  realpath: async (path) => await realpath(path),
  opendir: async (path) => await opendir(path),
  stat: async (path) => await stat(path),
}

export interface ListInput {
  /** The project's folder, already checked `ok`. */
  readonly site: Site
  /** The gate's shared folders that are there now. */
  readonly shared: readonly Site[]
  readonly dir: string | undefined
  readonly prefix: string
}

/** What one read of the disk gives, before any request applies its prefix. */
type Read =
  | { readonly kind: 'ok'; readonly entries: readonly ListingEntry[]; readonly partial: boolean }
  | { readonly kind: 'outside' }
  | { readonly kind: 'unreadable' }

interface Target {
  readonly root: Site
  readonly rootKind: 'site' | 'shared'
  /** What lies below the root, `''` or starting with the separator (without it only for a root of `/`). */
  readonly below: string
}

/**
 * ONE PER ENGINE. The in-flight map lives here, never at module level, where two engines — or two
 * tests — would share their reads (D4).
 */
export function createLister(deps: {
  readonly timers: Timers
  readonly disk?: ListingDisk
  readonly timeoutMs?: number
  readonly maxScan?: number
}): { readonly list: (input: ListInput) => Promise<FilesResult> } {
  const disk = deps.disk ?? realListingDisk
  const timeoutMs = deps.timeoutMs ?? LIST_TIMEOUT_MS
  const maxScan = deps.maxScan ?? MAX_SCAN
  const inflight = new Map<string, Promise<Read>>()

  /**
   * THE KEY IS THE PATH AS ASKED, not the real one: finding the real one is already I/O, and it is the
   * I/O that hangs on a hung mount. Not a cache — the entry goes when the read ends — but on a hung
   * mount the requests for one folder never pile up threads.
   */
  const read = (target: Target, dir: string): Promise<Read> => {
    const key = `${target.root.realPath}\0${dir}`
    const running = inflight.get(key)
    if (running !== undefined) return running
    const work = readFolder(disk, target, dir, maxScan).finally(() => {
      inflight.delete(key)
    })
    inflight.set(key, work)
    return work
  }

  const list = async (input: ListInput): Promise<FilesResult> => {
    const target = targetOf(input)
    if (target === undefined) return { outcome: 'outside' }
    if (target.below.split(sep).some(isHidden)) return { outcome: 'outside' }
    const dir = input.dir ?? input.site.realPath
    const result = await bounded<Read | 'timeout'>(read(target, dir), timeoutMs, deps.timers, () => 'timeout')
    if (result === 'timeout') return { outcome: 'timeout' }
    if (result.kind === 'outside') return { outcome: 'outside' }
    if (result.kind === 'unreadable') return { outcome: 'unreadable', reason: CANNOT_READ }
    return { outcome: 'ok', listing: shape(input, target, result.entries, result.partial) }
  }

  return { list }
}

/** The root `dir` hangs from: THE SITE FIRST, then the shared folders in the registry's order (D2). */
function targetOf(input: ListInput): Target | undefined {
  if (input.dir === undefined) return { root: input.site, rootKind: 'site', below: '' }
  if (insideSite(input.site, input.dir)) return { root: input.site, rootKind: 'site', below: belowOf(input.site, input.dir) }
  const shared = input.shared.find((site) => insideSite(site, input.dir as string))
  return shared === undefined ? undefined : { root: shared, rootKind: 'shared', below: belowOf(shared, input.dir) }
}

/** What lies below the root, by whichever of its two spellings the path was written in. */
function belowOf(root: Site, dir: string): string {
  const base = contains(root.path, dir) ? root.path : root.realPath
  return dir.slice(base.length)
}

/** Inside the root by its REAL path, and through no hidden folder on the way (D2, step 4). */
function allowedReal(root: Site, real: string): boolean {
  if (!contains(root.realPath, real)) return false
  return !real.slice(root.realPath.length).split(sep).some(isHidden)
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined
}

/** D2 steps 3–5 and D3 without the prefix. NEVER THROWS: a throw would reach the owner as a 500. */
async function readFolder(disk: ListingDisk, target: Target, dir: string, maxScan: number): Promise<Read> {
  let real: string
  try {
    real = await disk.realpath(dir)
  } catch (error) {
    const code = codeOf(error)
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'outside' } : { kind: 'unreadable' }
  }
  if (!allowedReal(target.root, real)) return { kind: 'outside' }

  // THE REAL PATH, already checked: a link in the asked path no longer counts from here.
  const entries: ListingEntry[] = []
  const links: string[] = []
  let partial = false
  try {
    let scanned = 0
    for await (const dirent of await disk.opendir(real)) {
      if (scanned >= maxScan) {
        partial = true
        break
      }
      scanned += 1
      if (isHidden(dirent.name)) continue
      if (dirent.isDirectory()) entries.push({ name: dirent.name, kind: 'dir' })
      else if (dirent.isFile()) entries.push({ name: dirent.name, kind: 'file' })
      else if (dirent.isSymbolicLink()) links.push(dirent.name)
      // A socket, a fifo, a device: nothing to reference.
    }
  } catch (error) {
    return codeOf(error) === 'ENOTDIR' ? { kind: 'outside' } : { kind: 'unreadable' }
  }

  for (let i = 0; i < links.length; i += LINK_BATCH) {
    const batch = await Promise.all(links.slice(i, i + LINK_BATCH).map((name) => followLink(disk, target.root, real, name)))
    for (const entry of batch) if (entry !== undefined) entries.push(entry)
  }
  return { kind: 'ok', entries, partial }
}

/** A link shows as what it points at only if that stays inside the SAME root; otherwise not at all. */
async function followLink(disk: ListingDisk, root: Site, folder: string, name: string): Promise<ListingEntry | undefined> {
  try {
    const target = await disk.realpath(join(folder, name))
    if (!allowedReal(root, target)) return undefined
    const info = await disk.stat(target)
    if (info.isDirectory()) return { name, kind: 'dir' }
    if (info.isFile()) return { name, kind: 'file' }
    return undefined
  } catch {
    return undefined
  }
}

const fold = (text: string): string => text.normalize('NFC').toLowerCase()

/** One request's view of a read: its prefix, the order, the ceiling, and the shared folders (D3). */
function shape(input: ListInput, target: Target, read: readonly ListingEntry[], partial: boolean): Listing {
  const dots = input.prefix.startsWith('.')
  const prefix = fold(input.prefix)
  const matches = (name: string) => (dots || !name.startsWith('.')) && fold(name).startsWith(prefix)
  const byName = (a: ListingEntry, b: ListingEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  const kept = read.filter((entry) => matches(entry.name))
  const sorted = [...kept.filter((e) => e.kind === 'dir').sort(byName), ...kept.filter((e) => e.kind === 'file').sort(byName)]
  const atSiteRoot = target.rootKind === 'site' && target.below === ''
  const shared = atSiteRoot
    ? input.shared
        .filter((site) => !contains(input.site.realPath, site.realPath))
        .map((site) => ({ path: site.path, name: basename(site.path) }))
        .filter((entry) => matches(entry.name))
    : []
  return {
    root: { kind: target.rootKind, path: target.root.path },
    dir: target.root.path + target.below,
    entries: sorted.slice(0, MAX_ENTRIES),
    shared,
    more: Math.max(0, sorted.length - MAX_ENTRIES),
    partial,
  }
}

/** The little of the project table a listing needs. Structural, so this file does not know the table. */
export interface ListingSites {
  readonly refresh: (id: string) => Promise<SiteCheck | undefined>
  readonly gateShared: () => readonly Site[]
  readonly sharedViews: () => readonly SharedView[]
}

/**
 * The engine's `files`: the project CHECKED AGAIN NOW, like a launch (`siteFor`), and the gate's shared
 * folders that are there now — what may be pointed at is what the agent may touch.
 */
export async function listFiles(
  lister: { readonly list: (input: ListInput) => Promise<FilesResult> },
  sites: ListingSites,
  query: FilesQuery,
): Promise<FilesResult> {
  const check = await sites.refresh(query.siteId)
  if (check === undefined) return { outcome: 'unknown' }
  if (check.status === 'missing') return { outcome: 'missing', siteId: query.siteId }
  const ok = new Set(sites.sharedViews().flatMap((view) => (view.status === 'ok' ? [view.path] : [])))
  const shared = sites.gateShared().filter((site) => ok.has(site.path))
  return await lister.list({ site: check.site, shared, dir: query.dir, prefix: query.prefix })
}
