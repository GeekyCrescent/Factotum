/**
 * THE SENDING SIDE of a handoff (spec 2026-10-07-dos-hosts, D9, steps 1–15), ONE PROJECT AT A TIME.
 *
 * ALL OR NOTHING PER PROJECT. Until the `commit` is sent, any failure aborts HERE, without waiting for
 * the peer: the target cannot have installed anything, and its TTL lets its side go if the `abort`
 * never arrives. Once `committing` is written the `commit` may have gone, and nothing aborts on a
 * guess: the source asks `status` until it knows, and if it never knows the project stays
 * `pending-peer`, with its lock, until the peer answers or the owner says «Keep them here».
 *
 * The target's word is read from `handoff.reason`, never from the status, and copied into the journal
 * — `targetReason`, `targetWarnings`, `targetPaths` — BEFORE deciding what to do with it (v4.3).
 */

import { lstat, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_BODY_BYTES, type PeerResponse } from '@factotum/core'
import { GIT_NET_TIMEOUT_MS } from '../git.ts'
import { HANDOFF_HOLDER_PREFIX } from '../locks.ts'
import { HANDOFF_ASSUMED_MBPS, HANDOFF_FILE_MAX_BYTES, HANDOFF_FILE_MAX_SECONDS } from './constants.ts'
import { sessionFiles } from './files.ts'
import { handoffBase, makeBundle } from './git-bundle.ts'
import { handoffGit, handoffGitSucceeds, remoteKey } from './git.ts'
import type { HandoffHost } from './host.ts'
import { newJournal, writeJournal, type Journal } from './journal.ts'
import { buildManifest, HANDOFF_MANIFEST_MAX_ENTRIES } from './manifest.ts'
import type { PlannedProject } from './plan.ts'
import { divergedOf, sessionsCheckSchema } from './snapshot.ts'
import { cleanSource, wipCommit } from './wip.ts'

/** `prepare` checks the tree and digests a few logs: half a minute (D9, step 3). */
export const PREPARE_TIMEOUT_MS = 30_000
/** Without a bundle the target may `fetch origin` on the manifest (D8, step 1). */
export const HANDOFF_MANIFEST_TIMEOUT_MS = GIT_NET_TIMEOUT_MS + 15_000
/** The `commit` runs git and installs every session: the peer's ceiling (D9, step 9). */
export const COMMIT_TIMEOUT_MS = 300_000
/** `abort` and `done`: sent once, and not waited for long. */
export const NOTICE_TIMEOUT_MS = 10_000
export const STATUS_POLL_MS = 5_000
export const HANDOFF_STATUS_WAIT_MS = 10 * 60_000
/** The kernel's ceiling on one call. */
const PEER_CALL_MAX_MS = 300_000

export interface SourceDeps {
  readonly host: HandoffHost
  /** Waiting between two `status`: on the module's timers, so a test moves it. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly statusWaitMs?: number
  readonly statusPollMs?: number
  /** Tests lower it to reach `code-too-large` without a 256 MiB repo. */
  readonly maxBundleBytes?: number
}

/** A file's own deadline (D8, step 2): twice the time at the assumed speed, never under 30 s. */
export function fileTimeoutMs(bytes: number, isBundle: boolean): number {
  const seconds = Math.max(30, (2 * bytes) / (HANDOFF_ASSUMED_MBPS * 1_000_000))
  return Math.min(PEER_CALL_MAX_MS, seconds * 1000 + (isBundle ? GIT_NET_TIMEOUT_MS : 0))
}

type Outcome = 'committed' | 'aborted' | 'pending-peer'

export function createSource(deps: SourceDeps) {
  const { host } = deps
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => host.timers.setTimeout(resolve, ms)))
  const gitOptions = host.gitEnv !== undefined ? { base: host.gitEnv } : {}
  const holderOf = (hid: string) => `${HANDOFF_HOLDER_PREFIX}${hid}`

  /**
   * One project, steps 1–15, inside its handoff queue; answers its final journal. NOTHING ESCAPES WITH
   * THE LOCK HELD: an error before `committing` aborts here like any refusal, one at `committing` leaves
   * the project `pending-peer` (the commit may have gone), and one later is the startup's (D11).
   */
  async function moveProject(hid: string, to: string, project: PlannedProject): Promise<Journal> {
    const steps = stepsOf(hid, to, project)
    try {
      return await steps.run()
    } catch {
      return await steps.recover()
    }
  }

  function stepsOf(hid: string, to: string, project: PlannedProject, existing?: Journal) {
    const path = host.projects().find((p) => p.id === project.siteId)?.path
    const route = (step: string) => `handoff/${hid}/${project.targetSiteId}/${step}`
    const work = host.paths.handoffWork(hid, project.siteId)
    const bundlePath = join(work, 'code.bundle')

    let journal: Journal = existing ?? {
      ...newJournal({ hid, siteId: project.siteId, role: 'source', peer: to, phase: 'locking', at: host.now().toISOString() }),
      peerSiteId: project.targetSiteId,
      branch: project.branch,
      sessionIds: [...project.sessions],
    }
    const save = async (patch: Partial<Journal>) => {
      journal = { ...journal, ...patch, at: host.now().toISOString() }
      await writeJournal(host.paths, journal)
      return journal
    }
    /** What the target said, in the journal BEFORE anything is decided (v4.3). */
    const heard = async (answer: PeerResponse<unknown>) => {
      const told = (answer.body as { handoff?: { reason?: unknown; warnings?: unknown; paths?: unknown; pathCount?: unknown } } | undefined)?.handoff
      if (told === undefined || told === null || typeof told !== 'object') return
      const warnings = Array.isArray(told.warnings) ? told.warnings.filter((w): w is string => typeof w === 'string') : []
      await save({
        ...(typeof told.reason === 'string' ? { targetReason: told.reason } : {}),
        targetWarnings: [...new Set([...journal.targetWarnings, ...warnings])],
        ...(Array.isArray(told.paths) ? { targetPaths: told.paths.filter((p): p is string => typeof p === 'string') } : {}),
        ...(typeof told.pathCount === 'number' ? { targetPathCount: told.pathCount } : {}),
      })
    }
    /** Before the `commit` left: abort HERE, without waiting for the peer (D9, «Abortar, en el origen»). */
    const abortLocal = async (reason: string | undefined, tellPeer: boolean): Promise<Journal> => {
      if (tellPeer) await host.peers.json(to, 'POST', route('abort'), {}, { timeoutMs: NOTICE_TIMEOUT_MS })
      await rm(bundlePath, { force: true })
      await save({ phase: 'aborted', ...(reason !== undefined ? { reason } : {}) })
      await host.locks.release(project.siteId, holderOf(hid))
      host.log.info(`handoff ${hid}: ${project.siteId} stays here (${reason ?? journal.targetReason ?? 'aborted'})`)
      return journal
    }

    async function run(): Promise<Journal> {
      await mkdir(work, { recursive: true })
      // 1–2. The journal before the lock; the lock loses at once to anyone.
      await writeJournal(host.paths, journal)
      if (path === undefined) return await save({ phase: 'aborted', reason: 'project-not-portable' })
      const lock = await host.locks.acquire(project.siteId, holderOf(hid), host.now().toISOString())
      if (!lock.ok) return await save({ phase: 'aborted', reason: 'project-busy' })
      await save({ phase: 'locked' })
      const prepared = await prepare(path)
      if ('phase' in prepared) return prepared
      const sending = await send(path, prepared.branchHead)
      if (sending !== undefined) return sending
      return await commit()
    }

    /** Step 3, and step 4 with its answer: `{ branchHead }` to go on, or the aborted journal. */
    async function prepare(path: string): Promise<{ readonly branchHead: string | undefined } | Journal> {
      const url = await handoffGit(path, ['config', '--get', 'remote.origin.url'], gitOptions).then((out) => out.trim(), () => '')
      const answer = await host.peers.json(to, 'POST', route('prepare'), { key: remoteKey(url), branch: project.branch, head: project.head, sessionIds: project.sessions, to }, { timeoutMs: PREPARE_TIMEOUT_MS })
      await heard(answer)
      if (!answer.ok) return await abortLocal(undefined, true)
      const body = answer.body as { branchHead?: unknown; sessions?: unknown }
      const branchHead = typeof body.branchHead === 'string' ? body.branchHead : undefined
      const sessions = sessionsCheckSchema.safeParse(body.sessions)
      if (!sessions.success) return await abortLocal('peer-error', true)
      // 4. AGAIN, here (D7): the target ahead, and a history that went another way.
      if (branchHead !== undefined && !(await handoffGitSucceeds(path, ['merge-base', '--is-ancestor', branchHead, project.head], gitOptions))) {
        return await abortLocal('target-ahead', true)
      }
      if ((await divergedOf(host, sessions.data)).size > 0) return await abortLocal('history-diverged', true)
      return { branchHead }
    }

    /** Steps 5–7: the services, the code, the files. `undefined` when all of it arrived. */
    async function send(path: string, branchHead: string | undefined): Promise<Journal | undefined> {
      // 5. The services stop AFTER prepare and BEFORE the WIP, and are named whatever happens next.
      const stopped: string[] = []
      for (const sessionId of project.sessions) stopped.push(...(await host.stopServices(sessionId)))
      if (stopped.length > 0) host.log.info(`handoff ${hid}: stopped ${stopped.length} service(s) in ${project.siteId}`)
      await save({ stoppedServices: stopped })

      // 6. The code: the WIP, a fetch that only reads, the bundle.
      const env = host.gitEnv !== undefined ? { env: host.gitEnv } : {}
      const made = await wipCommit(path, { indexFile: join(work, 'index'), hid, host: to, ...(host.gitEnv !== undefined ? { base: host.gitEnv } : {}) })
      if (made.head !== project.head) return await abortLocal('source-changed-during-handoff', true)
      await handoffGit(path, ['fetch', '--quiet', 'origin'], gitOptions).catch(() => host.log.warn(`handoff ${hid}: fetch origin failed in ${project.siteId}; using what refs/remotes already has`))
      const bundle = await makeBundle(path, { hid, head: made.head, wip: made.wip, base: handoffBase(branchHead), out: bundlePath, ...env })
      const bundleBytes = bundle === undefined ? 0 : (await lstat(bundle)).size
      const tooSlow = bundleBytes / (HANDOFF_ASSUMED_MBPS * 1_000_000) > HANDOFF_FILE_MAX_SECONDS
      if (bundleBytes > (deps.maxBundleBytes ?? HANDOFF_FILE_MAX_BYTES) || tooSlow) return await abortLocal('code-too-large', true)
      await save({ phase: 'sending', head: made.head, wip: made.wip, tree: made.tree })

      // 7. The manifest, then every file — the bundle first.
      const files = (await Promise.all(project.sessions.map(async (id) => (await sessionFiles(host, id)).files))).flat()
      const manifest = await buildManifest(files, bundle === undefined ? undefined : { abs: bundle, bytes: bundleBytes })
      if (manifest.entries.length > HANDOFF_MANIFEST_MAX_ENTRIES || Buffer.byteLength(JSON.stringify(manifest.entries)) > MAX_BODY_BYTES) {
        return await abortLocal('too-many-files', true)
      }
      const sent = await host.peers.json(to, 'POST', route('manifest'), manifest.entries, { timeoutMs: HANDOFF_MANIFEST_TIMEOUT_MS })
      await heard(sent)
      if (!sent.ok) return await abortLocal(undefined, true)
      for (const entry of manifest.entries) {
        const uploaded = await host.peers.upload(to, route(`file/${entry.n}`), manifest.sources.get(entry.n) ?? '', { timeoutMs: fileTimeoutMs(entry.bytes, entry.kind === 'git-bundle') })
        await heard(uploaded)
        if (!uploaded.ok) return await abortLocal(undefined, true)
      }
      return undefined
    }

    /** Steps 8–15: `committing` BEFORE the commit leaves, then what its answer means. */
    async function commit(): Promise<Journal> {
      await save({ phase: 'committing' })
      const answer = await host.peers.json(to, 'POST', route('commit'), {}, { timeoutMs: COMMIT_TIMEOUT_MS })
      await heard(answer)
      const outcome = await afterCommit(answer)
      if (outcome === 'pending-peer') {
        host.log.warn(`handoff ${hid}: ${project.siteId} is waiting for ${to} to say whether it was installed`)
        return await save({ phase: 'pending-peer' })
      }
      if (outcome === 'aborted') return await abortLocal(undefined, false)
      return await finish()
    }

    /** An error escaped a step: what the phase says it may have left (see `moveProject`). */
    async function recover(): Promise<Journal> {
      host.log.warn(`handoff ${hid}: a step failed in ${project.siteId} (${journal.phase})`)
      if (journal.phase === 'locking') return await save({ phase: 'aborted', reason: 'source-error' })
      if (journal.phase === 'locked' || journal.phase === 'sending') {
        return await abortLocal('source-error', true).catch(async () => await save({ phase: 'aborted', reason: 'source-error' }))
      }
      if (journal.phase === 'committing') return await save({ phase: 'pending-peer' })
      return journal
    }

    /** Step 10: what the commit's answer means, by `handoff.reason` (D9). */
    async function afterCommit(answer: PeerResponse<unknown>): Promise<Outcome> {
      if (answer.ok) return 'committed'
      if (answer.reason === 'http' && answer.status === 404) {
        // The commit itself found no journal: the target installed nothing (v4.3).
        await save({ targetReason: 'not-found' })
        return 'aborted'
      }
      if (journal.targetReason === 'abort-failed') return 'aborted'
      if (answer.reason === 'http') return await abortCommitting()
      return await waitForStatus()
    }

    /** No answer: ask until it is known (D9). A 404 here is NOT «aborted» — it may have pruned a `committed`. */
    async function waitForStatus(): Promise<Outcome> {
      const waitMs = deps.statusWaitMs ?? HANDOFF_STATUS_WAIT_MS
      const pollMs = deps.statusPollMs ?? STATUS_POLL_MS
      for (let waited = 0; waited < waitMs; waited += pollMs) {
        await sleep(pollMs)
        const answer = await host.peers.json(to, 'GET', route('status'), undefined, { timeoutMs: NOTICE_TIMEOUT_MS })
        await heard(answer)
        if (answer.ok) {
          const phase = (answer.body as { phase?: unknown }).phase
          if (phase === 'committed' || phase === 'done') return 'committed'
          if (phase === 'abort-failed') return 'aborted'
          if (phase === 'prepared' || phase === 'aborted') return await abortCommitting()
          continue
        }
        if (answer.reason === 'http' && answer.status === 404) return 'pending-peer'
      }
      return 'pending-peer'
    }

    /** The commit may have gone: ask the target to undo, and WAIT for its word (D9). */
    async function abortCommitting(): Promise<Outcome> {
      const answer = await host.peers.json(to, 'POST', route('abort'), {}, { timeoutMs: NOTICE_TIMEOUT_MS })
      await heard(answer)
      if (answer.ok || (answer.reason === 'http' && answer.status === 410)) return 'aborted'
      const reason = (answer.body as { handoff?: { reason?: unknown } } | undefined)?.handoff?.reason
      if (answer.reason === 'http' && answer.status === 409 && reason === 'committed') return 'committed'
      if (answer.reason === 'http' && answer.status === 409 && reason === 'abort-failed') return 'aborted'
      return 'pending-peer'
    }

    /** Steps 11–15: the sessions are the other host's now; this side cleans up and tells it, once. */
    async function finish(): Promise<Journal> {
      const at = host.now().toISOString()
      for (const sessionId of project.sessions) await host.store.patchMeta(sessionId, (meta) => ({ ...meta, movedTo: to, movedAt: at }))
      await save({ phase: 'acked' })
      return await cleanAndRelease(journal)
    }

    /**
     * A `pending-peer` (also one a restart made of `committing`), when the peer is back (D11, row
     * «pending-peer»): `status`, by the table of step 10. Still unknown: it stays as it is.
     */
    async function settlePending(): Promise<Journal> {
      const answer = await host.peers.json(to, 'GET', route('status'), undefined, { timeoutMs: NOTICE_TIMEOUT_MS })
      await heard(answer)
      if (!answer.ok) return journal
      const phase = (answer.body as { phase?: unknown }).phase
      let outcome: Outcome = 'pending-peer'
      if (phase === 'committed' || phase === 'done') outcome = 'committed'
      else if (phase === 'abort-failed') outcome = 'aborted'
      else if (phase === 'prepared' || phase === 'aborted') outcome = await abortCommitting()
      if (outcome === 'committed') return await finish()
      if (outcome === 'aborted') return await abortLocal(undefined, false)
      return journal
    }

    /** The startup's `locked` and `sending` (D11, column 2): aborted here, without the peer. */
    const abortAfterRestart = async () => await abortLocal('restarted', false)

    return { run, recover, settlePending, abortAfterRestart, finish }
  }

  /** The steps of a journal found on disk, for the startup (D11). */
  function resumeOf(journal: Journal) {
    const project: PlannedProject = {
      siteId: journal.siteId,
      targetSiteId: journal.peerSiteId ?? '',
      branch: journal.branch ?? '',
      head: journal.head ?? '',
      sessions: journal.sessionIds ?? [],
      localCommits: 0,
      changedFiles: 0,
      newUntracked: [],
      bytes: 0,
      warnings: [],
    }
    return stepsOf(journal.hid, journal.peer, project, journal)
  }

  /**
   * Steps 13–15, also the startup's row `acked` (D11): clean the source if it is still what travelled,
   * drop the bundle, `done`, let go — and tell the peer once, without waiting for it to work out.
   */
  async function cleanAndRelease(start: Journal, tellPeer = true): Promise<Journal> {
    let journal = start
    const path = host.projects().find((p) => p.id === journal.siteId)?.path
    const work = host.paths.handoffWork(journal.hid, journal.siteId)
    // After a restart the work folder may be gone; the temporary index of `wipTree` lives in it.
    await mkdir(work, { recursive: true })
    if (path !== undefined && journal.head !== undefined && journal.tree !== undefined) {
      const cleaned = await cleanSource(path, { hid: journal.hid, head: journal.head, wip: journal.wip, tree: journal.tree, indexFile: join(work, 'index'), ...(host.gitEnv !== undefined ? { env: host.gitEnv } : {}) })
      if (cleaned !== 'cleaned') {
        host.log.warn(`handoff ${journal.hid}: ${journal.siteId} changed here during the handoff; it was not cleaned, and the WIP is kept in refs/factotum/handoff-backup/${journal.hid}`)
        if (journal.wip !== undefined) await handoffGit(path, ['update-ref', `refs/factotum/handoff-backup/${journal.hid}`, journal.wip], gitOptions).catch(() => undefined)
        journal = { ...journal, warnings: [...journal.warnings, cleaned] }
      }
    }
    await rm(join(work, 'code.bundle'), { force: true })
    journal = { ...journal, phase: 'done', at: host.now().toISOString() }
    await writeJournal(host.paths, journal)
    await host.locks.release(journal.siteId, holderOf(journal.hid))
    // ONCE, and nobody retries it: the target's leftovers go with it or with its prune (v4.1).
    if (tellPeer) await host.peers.json(journal.peer, 'POST', `handoff/${journal.hid}/${journal.peerSiteId}/done`, {}, { timeoutMs: NOTICE_TIMEOUT_MS })
    return journal
  }

  return { moveProject, cleanAndRelease, resumeOf }
}

export type Source = ReturnType<typeof createSource>
