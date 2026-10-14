/**
 * The handoff, as the engine hands it to the module's routes (spec 2026-10-07-dos-hosts, D13). Every
 * answer is a `Wire`: the routes turn it into HTTP and add nothing.
 *
 * THE RAW TEXT OF EVERY ID ARRIVES HERE, and is checked here before it becomes a path (D13, «Quién
 * valida el `hid`»): `modules/sessions/server.ts` imports only from `@factotum/core` and cannot call
 * `isSessionId`, as it already does with every `:id` of a session.
 */

import { uuidv7 } from '../id.ts'
import { KeyedQueue } from '../keyed-queue.ts'
import { HANDOFF_HOLDER_PREFIX } from '../locks.ts'
import type { HandoffHost } from './host.ts'
import { isHandoffId, listHids, listJournals, readJournal, readRun, writeJournal, writeRun, type Journal, type Run } from './journal.ts'
import { compute, createPreviews, PreviewError } from './preview.ts'
import { sessionsCheck, targetProjects } from './snapshot.ts'
import { createSource, type SourceDeps } from './source.ts'
import { createTarget } from './target.ts'
import { createResume } from './resume.ts'
import { accepted, invalid, notFound, ok, refuse, type Wire } from './wire.ts'

export interface HandoffApi {
  // --- the app ---
  /** `POST /handoff/preview {to}`: 202 `{ previewId }`, and the preview runs apart (v4.3). */
  readonly startPreview: (body: unknown) => Wire
  /** `GET /handoff/preview/:previewId`. */
  readonly preview: (previewId: string) => Wire
  /** `POST /handoff {to}`: 202 `{ hid }`, and the handoff runs apart; 409 while one is alive. */
  readonly start: (body: unknown) => Promise<Wire>
  /** `GET /handoff/:hid`: the progress and the report, from `run.json` and the journals. */
  readonly report: (hid: string) => Promise<Wire>
  /** `POST /handoff/:hid/:siteId/keep`: «Keep them here», only in `pending-peer` (D9). */
  readonly keep: (hid: string, siteId: string) => Promise<Wire>
  // --- the peer ---
  /** `GET /handoff/projects`, for the peer and `doctor`: this host's portable projects (D7). */
  readonly projects: () => Promise<Wire>
  /** `POST /handoff/sessions-check {ids}`: the digest of each session this host has. */
  readonly sessionsCheck: (body: unknown) => Promise<Wire>
  readonly prepare: (hid: string, siteId: string, body: unknown) => Promise<Wire>
  readonly manifest: (hid: string, siteId: string, body: unknown) => Promise<Wire>
  readonly file: (hid: string, siteId: string, n: string, file: { readonly path: string; readonly bytes: number } | undefined) => Promise<Wire>
  readonly commit: (hid: string, siteId: string) => Promise<Wire>
  readonly abort: (hid: string, siteId: string) => Promise<Wire>
  readonly done: (hid: string, siteId: string) => Promise<Wire>
  readonly status: (hid: string, siteId: string) => Promise<Wire>
  // --- the module's life ---
  /** Inside `start()`, after the locks are reconciled: the journals and the holders only (D11, moment 1). */
  readonly atStart: () => Promise<void>
  /** Arms moments 2 and 3 and the daily prune (D11). */
  readonly schedule: () => void
  /** Moment 2 itself, which `schedule` runs on a timer of 0; and moment 3's one pass. Tests call them. */
  readonly afterStart: () => Promise<void>
  readonly poll: () => Promise<void>
  /** Disarms every timer of the handoff. The engine's `stop()`. */
  readonly stop: () => void
  /** For tests: resolves when the handoff `start` began is over. */
  readonly settled: () => Promise<void>
}

export interface HandoffOptions {
  readonly ttlMs?: number
  readonly source?: Omit<SourceDeps, 'host'>
}

/** A peer's name as `/peers/<name>/` carries it, and one this host has. */
export function peerOf(host: Pick<HandoffHost, 'peers'>, body: unknown): string | undefined {
  const to = (body as { to?: unknown } | null | undefined)?.to
  if (typeof to !== 'string' || !/^[a-z0-9-]+$/.test(to)) return undefined
  return host.peers.list().some((peer) => peer.name === to) ? to : undefined
}

/** Phases with nothing left to do and no lock held: a handoff with only these is not alive. */
const RESTING: readonly string[] = ['aborted', 'done', 'kept', 'committed', 'abort-failed']

export function createHandoff(host: HandoffHost, options: HandoffOptions = {}): HandoffApi {
  const queue = new KeyedQueue()
  const target = createTarget({ host, queue, ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}) })
  const source = createSource({ host, ...options.source })
  const resume = createResume({ host, queue, source, target, ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}) })
  const previews = createPreviews({ run: async (to) => (await compute(host, to)).plan, timers: host.timers, now: host.now, log: host.log })
  let running: Promise<void> = Promise.resolve()
  let busy = false

  const alive = async (): Promise<boolean> => {
    for (const hid of await listHids(host.paths)) {
      if ((await listJournals(host.paths, hid)).some((journal) => journal.role === 'source' && !RESTING.includes(journal.phase))) return true
    }
    return false
  }

  /** The whole handoff, apart from the request that started it: the plan, then each project in turn. */
  async function run(hid: string, to: string, startedAt: string): Promise<void> {
    const base: Run = { hid, peer: to, startedAt, siteIds: [], state: 'planning' }
    await writeRun(host.paths, base)
    try {
      const { plan } = await compute(host, to)
      const planned: Run = { ...base, siteIds: plan.projects.map((p) => p.siteId), state: 'running', skipped: plan.skipped.map((s) => ({ ...s })), totals: plan.totals }
      await writeRun(host.paths, planned)
      for (const project of plan.projects) {
        const journal = await queue.run(project.siteId, () => source.moveProject(hid, to, project))
        // The peer may come back later: the interval asks it then (D11, moment 3).
        if (journal.phase === 'pending-peer') resume.wake()
      }
      await writeRun(host.paths, { ...planned, state: 'finished' })
    } catch (error) {
      const failure = error instanceof PreviewError ? error.reason : 'internal'
      // The reason, never the message: it can carry a path of this host.
      host.log.warn(`handoff ${hid} failed: ${failure}`)
      await writeRun(host.paths, { ...base, state: 'failed', failure })
    }
  }

  const projectOf = (journal: Journal) => ({
    siteId: journal.siteId,
    phase: journal.phase,
    sessions: journal.sessionIds ?? [],
    reason: journal.reason,
    warnings: journal.warnings,
    stoppedServices: journal.stoppedServices,
    targetReason: journal.targetReason,
    targetWarnings: journal.targetWarnings,
    targetPaths: journal.targetPaths,
    targetPathCount: journal.targetPathCount,
  })

  return {
    startPreview: (body) => {
      const to = peerOf(host, body)
      if (to === undefined) return invalid('a preview needs { to } naming a peer of this host')
      return accepted({ previewId: previews.start(to) })
    },
    preview: (previewId) => {
      if (!isHandoffId(previewId)) return invalid(`"${previewId}" is not a preview id`)
      const state = previews.get(previewId)
      return state === undefined ? notFound('no such preview; it may have expired, or the daemon restarted') : ok(state)
    },
    start: async (body) => {
      const to = peerOf(host, body)
      if (to === undefined) return invalid('a handoff needs { to } naming a peer of this host')
      // Taken BEFORE the await (code review): two POSTs at once cannot both pass.
      if (busy) return refuse('handoff-alive', 'a handoff from this host is still going on')
      busy = true
      if (await alive()) {
        busy = false
        return refuse('handoff-alive', 'a handoff from this host is still going on')
      }
      const hid = uuidv7(host.now().getTime())
      running = run(hid, to, host.now().toISOString()).finally(() => {
        busy = false
      })
      return accepted({ hid })
    },
    report: async (hid) => {
      if (!isHandoffId(hid)) return invalid(`"${hid}" is not a handoff id`)
      const runFile = await readRun(host.paths, hid)
      if (runFile === undefined) return notFound('no handoff with that id on this host')
      const journals = (await listJournals(host.paths, hid)).filter((journal) => journal.role === 'source')
      return ok({ ...runFile, projects: journals.map(projectOf) })
    },
    keep: async (hid, siteId) => {
      if (!isHandoffId(hid)) return invalid(`"${hid}" is not a handoff id`)
      return await queue.run(siteId, async () => {
        const journal = await readJournal(host.paths, hid, siteId)
        if (journal === undefined || journal.role !== 'source') return notFound('no handoff with that id for that project on this host')
        if (journal.phase !== 'pending-peer') return refuse('wrong-phase', `this project is ${journal.phase}, not waiting for the other host`)
        // KEPT: the sessions stay here without movedTo, the tree is not touched, and the peer is not called again.
        await writeJournal(host.paths, { ...journal, phase: 'kept', at: host.now().toISOString() })
        await host.locks.release(siteId, `${HANDOFF_HOLDER_PREFIX}${hid}`)
        host.log.warn(`handoff ${hid}: ${siteId} kept here by the owner; if the other host installed it, the two copies now go on apart`)
        return ok({ phase: 'kept' })
      })
    },
    projects: async () => ok(await targetProjects(host)),
    sessionsCheck: async (body) => {
      const ids = (body as { ids?: unknown } | null | undefined)?.ids
      if (!Array.isArray(ids)) return invalid('sessions-check takes { ids: [...] }')
      return ok(await sessionsCheck(host, ids))
    },
    prepare: target.prepare,
    manifest: target.manifest,
    file: target.file,
    commit: target.commit,
    abort: target.abort,
    done: target.done,
    status: target.status,
    atStart: resume.atStart,
    schedule: resume.schedule,
    afterStart: resume.afterStart,
    poll: resume.poll,
    stop: () => {
      target.stop()
      resume.stop()
    },
    settled: () => running,
  }
}
