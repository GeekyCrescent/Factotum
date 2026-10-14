/**
 * What the target checks of the peer's word before it holds a project or installs anything (security
 * review of the branch, 2026-10-14). The peer is the owner's other daemon and there is no credential
 * between them (ADR-0002), but its word must not be able to take more than the handoff is for:
 * destroy a conversation this host owns, keep a project locked for ever, fill the disk, or decide how
 * long the owner's backups live.
 */

import { readFile, statfs } from 'node:fs/promises'
import type { HandoffHost } from './host.ts'
import { listHids, listJournals } from './journal.ts'
import { extendsLog, logDigest } from './log-digest.ts'
import { hidTime } from './prune.ts'

/** A `hid` whose time is further than this from this host's clock is refused. */
export const HANDOFF_HID_SKEW_MS = 24 * 3_600_000
/** At most this many sessions in one project's `prepare`. */
export const HANDOFF_MAX_SESSIONS = 200
/** A `meta.json` is a few hundred bytes; this is room and to spare. */
export const HANDOFF_META_MAX_BYTES = 1024 * 1024
/** One project's files together, at most. Ten of the largest transcripts measured (98 MB) fit. */
export const HANDOFF_PROJECT_MAX_BYTES = 4 * 1024 * 1024 * 1024
/** Free space left after the files, at least. */
export const HANDOFF_FREE_MARGIN_BYTES = 1024 * 1024 * 1024
/**
 * A `prepared` lets go after this long FROM `prepare`, whatever keeps arriving: the TTL re-arms with
 * each file (D9), and without a ceiling a peer could keep a project locked by sending forever.
 */
export const HANDOFF_PREPARED_MAX_MS = 60 * 60_000

const LIVE: readonly string[] = ['preparing', 'prepared', 'installing']

/** The `hid`'s time is near this host's clock: its age means something, and is not the peer's choice. */
export function hidIsFresh(hid: string, now: Date): boolean {
  return Math.abs(now.getTime() - hidTime(hid)) <= HANDOFF_HID_SKEW_MS
}

/** Another handoff is being received here: one at a time, so a peer cannot hold every project at once. */
export async function anotherLive(host: Pick<HandoffHost, 'paths'>, hid: string): Promise<boolean> {
  for (const other of await listHids(host.paths)) {
    if (other === hid) continue
    if ((await listJournals(host.paths, other)).some((journal) => journal.role === 'target' && LIVE.includes(journal.phase))) return true
  }
  return false
}

/**
 * A session the peer names that THIS HOST still owns may not be replaced: only one this host moved
 * away (`movedTo`), of this project, and at rest. Otherwise the import would move the owner's live copy
 * to `replaced/`, and `done` would delete it.
 */
export async function localConflict(host: Pick<HandoffHost, 'store'>, siteId: string, sessionIds: readonly string[]): Promise<string | undefined> {
  for (const id of sessionIds) {
    const meta = await host.store.readMeta(id)
    if (meta === undefined) continue
    if (meta.state === 'running') return 'target-busy'
    if (meta.siteId !== siteId) return 'session-elsewhere'
    if (meta.movedTo === undefined) return 'history-diverged'
  }
  return undefined
}

/**
 * At the commit: the log that arrived EXTENDS this host's copy of every session it replaces — checked
 * here on the bytes, not taken from the source's word in step 4.
 */
export async function stagedExtends(host: Pick<HandoffHost, 'paths'>, staging: string, sessionIds: readonly string[]): Promise<boolean> {
  for (const id of sessionIds) {
    const local = await readFile(host.paths.eventsFile(id), 'utf8').catch(() => undefined)
    if (local === undefined) continue
    const staged = await readFile(`${staging}/${id}/session/events.jsonl`, 'utf8').catch(() => '')
    if (!extendsLog(staged, logDigest(local))) return false
  }
  return true
}

/** Room on the disk of `dir` for `bytes` and the margin. A disk that cannot be asked is not refused. */
export async function hasRoom(dir: string, bytes: number): Promise<boolean> {
  const stats = await statfs(dir).catch(() => undefined)
  if (stats === undefined) return true
  return stats.bavail * stats.bsize >= bytes + HANDOFF_FREE_MARGIN_BYTES
}
