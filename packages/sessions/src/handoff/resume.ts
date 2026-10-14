/**
 * A restart in the middle of a handoff (spec 2026-10-07-dos-hosts, D11): the journal says what to do,
 * in THREE MOMENTS, because `start()` has 10 s and a `reset --hard` of the vault may not fit:
 *
 *   1. `atStart`, inside `start()`: read the journals and decide the holders. NO GIT AND NO PEER
 *      (guardrail 12);
 *   2. `afterStart`, on a timer of 0: what needs git or the disk, through each project's queue, with
 *      the lock still on so nobody walks in meanwhile; then the prune;
 *   3. `poll`, on an interval: when the peer is reachable, what needs it.
 *
 * NO PHASE OF THE SOURCE WAITS FOR THE PEER FOR EVER: before `committing` it aborts here; `committing`
 * and `pending-peer` have «Keep them here»; `acked` is local.
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { KeyedQueue } from '../keyed-queue.ts'
import { HANDOFF_HOLDER_PREFIX } from '../locks.ts'
import { HANDOFF_PREPARED_TTL_MS } from './constants.ts'
import type { HandoffHost } from './host.ts'
import { listHids, listJournals, readJournal, writeJournal, type Journal } from './journal.ts'
import { HANDOFF_PRUNE_MS, prune } from './prune.ts'
import { NOTICE_TIMEOUT_MS, type Source } from './source.ts'
import type { Target } from './target.ts'

/** The peer is asked at the probe's rhythm (`PEER_PROBE_MS`). */
export const HANDOFF_PEER_POLL_MS = 15_000

export interface ResumeDeps {
  readonly host: HandoffHost
  readonly queue: KeyedQueue
  readonly source: Source
  readonly target: Target
  readonly ttlMs?: number
}

export function createResume(deps: ResumeDeps) {
  const { host, queue, source, target } = deps
  const ttlMs = deps.ttlMs ?? HANDOFF_PREPARED_TTL_MS
  const holder = (hid: string) => `${HANDOFF_HOLDER_PREFIX}${hid}`
  const local: Journal[] = []
  /** `locked` and `sending` after their local abort: an `abort` to the peer, ONCE (D11). */
  const tellAbort: Journal[] = []
  let polling: Disposable | undefined
  let pruning: Disposable | undefined

  const save = async (journal: Journal, patch: Partial<Journal>) => {
    const next = { ...journal, ...patch, at: host.now().toISOString() }
    await writeJournal(host.paths, next)
    return next
  }
  const release = (journal: Journal) => host.locks.release(journal.siteId, holder(journal.hid))

  /** Moment 1: the journals and the holders, nothing else. */
  async function atStart(): Promise<void> {
    for (const hid of await listHids(host.paths)) {
      for (const journal of await listJournals(host.paths, hid)) await rowOf(journal)
    }
  }

  async function rowOf(journal: Journal): Promise<void> {
    if (journal.role === 'source') {
      if (journal.phase === 'locking') {
        // The peer knows nothing yet: `prepare` comes after `locked`.
        await release(journal)
        await save(journal, { phase: 'aborted', reason: 'restarted' })
      } else if (journal.phase === 'committing') await save(journal, { phase: 'pending-peer' })
      else if (journal.phase === 'locked' || journal.phase === 'sending' || journal.phase === 'acked') local.push(journal)
      else if (journal.phase === 'aborted' || journal.phase === 'done' || journal.phase === 'kept') await release(journal)
      return
    }
    if (journal.phase === 'preparing') {
      await release(journal)
      await save(journal, { phase: 'aborted', reason: 'restarted' })
    } else if (journal.phase === 'prepared') {
      if (Date.parse(journal.lastSignalAt ?? journal.at) + ttlMs <= host.now().getTime()) {
        await rm(join(host.paths.handoffWork(journal.hid, journal.siteId), 'staging'), { recursive: true, force: true })
        await save(journal, { phase: 'aborted', reason: 'expired' })
        await release(journal)
      } else target.rearm(journal)
    } else if (journal.phase === 'installing') local.push(journal)
    // `committed` (the daemon fell between the phase and the release), `abort-failed`, `aborted`, `done`:
    // let go if still held. Nothing else: `status` answers from the journal.
    else await release(journal)
  }

  /** Moment 2: git and the disk, by each project's queue; then the prune. */
  async function afterStart(): Promise<void> {
    for (const journal of local.splice(0)) {
      await queue.run(journal.siteId, async () => {
        if (journal.role === 'target') await target.undo(journal, 'restarted')
        else if (journal.phase === 'acked') await source.cleanAndRelease(journal, false)
        else {
          await source.resumeOf(journal).abortAfterRestart()
          tellAbort.push(journal)
        }
      })
    }
    await prune(host, queue)
    if (tellAbort.length > 0 || (await pendingPeers()).length > 0) wake()
  }

  async function pendingPeers(): Promise<readonly Journal[]> {
    const out: Journal[] = []
    for (const hid of await listHids(host.paths)) {
      for (const journal of await listJournals(host.paths, hid)) if (journal.role === 'source' && journal.phase === 'pending-peer') out.push(journal)
    }
    return out
  }

  /** Moment 3: with the peer reachable, what is left. The interval goes when nothing is. */
  async function poll(): Promise<void> {
    const reachable = new Set(host.peers.list().filter((peer) => peer.reachable).map((peer) => peer.name))
    for (const journal of tellAbort.splice(0)) {
      if (!reachable.has(journal.peer)) {
        tellAbort.push(journal)
        continue
      }
      await host.peers.json(journal.peer, 'POST', `handoff/${journal.hid}/${journal.peerSiteId}/abort`, {}, { timeoutMs: NOTICE_TIMEOUT_MS })
    }
    const pending = await pendingPeers()
    for (const journal of pending) {
      if (!reachable.has(journal.peer)) continue
      await queue.run(journal.siteId, async () => {
        const current = await readJournal(host.paths, journal.hid, journal.siteId)
        if (current?.phase === 'pending-peer') await source.resumeOf(current).settlePending()
      })
    }
    if (tellAbort.length === 0 && (await pendingPeers()).length === 0) {
      polling?.[Symbol.dispose]()
      polling = undefined
    }
  }

  /** Starts the interval if it is not running: after a restart, or when a live run leaves a `pending-peer`. */
  function wake(): void {
    polling ??= host.timers.setInterval(() => void poll(), HANDOFF_PEER_POLL_MS)
  }

  /** Moments 2 and 3 armed, and the daily prune. Called right after `atStart`, still inside `start()`. */
  function schedule(): void {
    host.timers.setTimeout(() => void afterStart(), 0)
    pruning ??= host.timers.setInterval(() => void prune(host, queue), HANDOFF_PRUNE_MS)
  }

  function stop(): void {
    polling?.[Symbol.dispose]()
    pruning?.[Symbol.dispose]()
    polling = undefined
    pruning = undefined
  }

  return { atStart, afterStart, poll, wake, schedule, stop }
}
