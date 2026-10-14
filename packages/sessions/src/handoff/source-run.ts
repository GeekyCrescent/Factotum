/**
 * ONE PROJECT OF A HANDOFF, ON THE SOURCE (spec 2026-10-07-dos-hosts, D9, steps 1–15): a small class,
 * one method per step, all of them writing to ONE journal (the project's queue is its only writer).
 *
 * ALL OR NOTHING PER PROJECT. Until the `commit` is sent, any failure aborts HERE, without waiting for
 * the peer: the target cannot have installed anything, and its TTL lets its side go if the `abort`
 * never arrives. Once `committing` is written the `commit` may have gone, and nothing aborts on a
 * guess: the source asks `status` until it knows, and if it never knows the project stays
 * `pending-peer`, with its lock, until the peer answers or the owner says «Keep them here».
 */

import { lstat, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_BODY_BYTES, type PeerResponse } from '@factotum/core'
import { HANDOFF_HOLDER_PREFIX } from '../locks.ts'
import { HANDOFF_ASSUMED_MBPS, HANDOFF_FILE_MAX_SECONDS, HANDOFF_PATHS_MAX } from './constants.ts'
import { sessionFiles } from './files.ts'
import { handoffBase, makeBundle } from './git-bundle.ts'
import { handoffGit, handoffGitSucceeds, remoteKey } from './git.ts'
import type { HandoffHost } from './host.ts'
import { writeJournal, type Journal } from './journal.ts'
import { buildManifest, HANDOFF_MANIFEST_MAX_ENTRIES } from './manifest.ts'
import type { PlannedProject } from './plan.ts'
import { divergedOf, sessionsCheckSchema } from './snapshot.ts'
import { wipCommit } from './wip.ts'

/** `prepare` checks the tree and digests a few logs: half a minute (D9, step 3). */
export const PREPARE_TIMEOUT_MS = 30_000
/** Without a bundle the target may `fetch origin` on the manifest (D8, step 1). */
export const HANDOFF_MANIFEST_TIMEOUT_MS = 45_000
/** The `commit` runs git and installs every session: the peer's ceiling (D9, step 9). */
export const COMMIT_TIMEOUT_MS = 300_000
/** `abort` and `done`: sent once, and not waited for long. */
export const NOTICE_TIMEOUT_MS = 10_000
export const STATUS_POLL_MS = 5_000
export const HANDOFF_STATUS_WAIT_MS = 10 * 60_000
/** The kernel's ceiling on one call. */
const PEER_CALL_MAX_MS = 300_000
/** `git fetch origin`'s budget, which the bundle's deadline adds for `ensureBase` (D8, step 2). */
const FETCH_BUDGET_MS = 30_000

const SHA = /^[0-9a-f]{40,64}$/
const CODE = /^[a-z0-9-]{1,40}$/

/** A file's own deadline (D8, step 2): twice the time at the assumed speed, never under 30 s. */
export function fileTimeoutMs(bytes: number, isBundle: boolean): number {
  const seconds = Math.max(30, (2 * bytes) / (HANDOFF_ASSUMED_MBPS * 1_000_000))
  return Math.min(PEER_CALL_MAX_MS, seconds * 1000 + (isBundle ? FETCH_BUDGET_MS : 0))
}

/**
 * What the target said (its `handoff`), CHECKED: it is another daemon's word, and it goes into this
 * host's journal and report. A reason and each warning are short codes; the paths are capped and cut.
 */
export function toldOf(body: unknown): Partial<Pick<Journal, 'targetReason' | 'targetPaths' | 'targetPathCount'>> & { readonly warnings: readonly string[] } {
  const told = (body as { handoff?: unknown } | null | undefined)?.handoff as { reason?: unknown; warnings?: unknown; paths?: unknown; pathCount?: unknown } | undefined
  if (told === undefined || told === null || typeof told !== 'object') return { warnings: [] }
  const code = (value: unknown): value is string => typeof value === 'string' && CODE.test(value)
  const warnings = Array.isArray(told.warnings) ? told.warnings.filter(code).slice(0, 10) : []
  const paths = Array.isArray(told.paths) ? told.paths.filter((p): p is string => typeof p === 'string').slice(0, HANDOFF_PATHS_MAX).map((p) => p.slice(0, 500)) : undefined
  const count = typeof told.pathCount === 'number' && Number.isInteger(told.pathCount) && told.pathCount >= 0 ? told.pathCount : undefined
  return {
    warnings,
    ...(code(told.reason) ? { targetReason: told.reason } : {}),
    ...(paths !== undefined ? { targetPaths: paths } : {}),
    ...(count !== undefined ? { targetPathCount: count } : {}),
  }
}

export interface RunDeps {
  readonly host: HandoffHost
  readonly sleep: (ms: number) => Promise<void>
  readonly statusWaitMs: number
  readonly statusPollMs: number
  readonly maxBundleBytes: number
  /** Steps 13–15, shared with the startup's row `acked`. */
  readonly cleanAndRelease: (journal: Journal, tellPeer?: boolean) => Promise<Journal>
}

type Outcome = 'committed' | 'aborted' | 'pending-peer'

export class ProjectRun {
  readonly #deps: RunDeps
  readonly #project: PlannedProject
  readonly #path: string | undefined
  readonly #work: string
  #journal: Journal

  constructor(deps: RunDeps, project: PlannedProject, journal: Journal) {
    this.#deps = deps
    this.#project = project
    this.#journal = journal
    this.#path = deps.host.projects().find((p) => p.id === project.siteId)?.path
    this.#work = deps.host.paths.handoffWork(journal.hid, project.siteId)
  }

  get journal(): Journal {
    return this.#journal
  }

  get #host(): HandoffHost {
    return this.#deps.host
  }

  #route(step: string): string {
    return `handoff/${this.#journal.hid}/${this.#project.targetSiteId}/${step}`
  }

  get #bundlePath(): string {
    return join(this.#work, 'code.bundle')
  }

  async #save(patch: Partial<Journal>): Promise<Journal> {
    this.#journal = { ...this.#journal, ...patch, at: this.#host.now().toISOString() }
    await writeJournal(this.#host.paths, this.#journal)
    return this.#journal
  }

  /** What the target said, in the journal BEFORE anything is decided (v4.3). */
  async #heard(answer: PeerResponse<unknown>): Promise<void> {
    const told = toldOf(answer.body)
    if (told.targetReason === undefined && told.warnings.length === 0 && told.targetPaths === undefined) return
    const { warnings, ...rest } = told
    await this.#save({ ...rest, targetWarnings: [...new Set([...this.#journal.targetWarnings, ...warnings])] })
  }

  async #ask(method: 'GET' | 'POST', step: string, body: unknown, timeoutMs: number): Promise<PeerResponse<unknown>> {
    const answer = await this.#host.peers.json(this.#journal.peer, method, this.#route(step), body, { timeoutMs })
    await this.#heard(answer)
    return answer
  }

  #release(): Promise<void> {
    return this.#host.locks.release(this.#project.siteId, `${HANDOFF_HOLDER_PREFIX}${this.#journal.hid}`)
  }

  /** Before the `commit` left: abort HERE, without waiting for the peer (D9, «Abortar, en el origen»). */
  async #abortLocal(reason: string | undefined, tellPeer: boolean): Promise<Journal> {
    try {
      if (tellPeer) await this.#host.peers.json(this.#journal.peer, 'POST', this.#route('abort'), {}, { timeoutMs: NOTICE_TIMEOUT_MS })
      await rm(this.#bundlePath, { force: true })
      await this.#save({ phase: 'aborted', ...(reason !== undefined ? { reason } : {}) })
    } finally {
      // Let go whatever happened above: a lock nobody holds a reason for closes the project.
      await this.#release()
    }
    this.#host.log.info(`handoff ${this.#journal.hid}: ${this.#project.siteId} stays here (${reason ?? this.#journal.targetReason ?? 'aborted'})`)
    return this.#journal
  }

  /** Steps 1–15. */
  async run(): Promise<Journal> {
    await mkdir(this.#work, { recursive: true })
    // 1–2. The journal before the lock; the lock loses at once to anyone.
    await writeJournal(this.#host.paths, this.#journal)
    if (this.#path === undefined) return await this.#save({ phase: 'aborted', reason: 'project-not-portable' })
    const lock = await this.#host.locks.acquire(this.#project.siteId, `${HANDOFF_HOLDER_PREFIX}${this.#journal.hid}`, this.#host.now().toISOString())
    if (!lock.ok) return await this.#save({ phase: 'aborted', reason: 'project-busy' })
    await this.#save({ phase: 'locked' })
    const prepared = await this.#prepare(this.#path)
    if ('phase' in prepared) return prepared
    const sending = await this.#send(this.#path, prepared.branchHead)
    if (sending !== undefined) return sending
    return await this.#commit()
  }

  /** Step 3, and step 4 with its answer: `{ branchHead }` to go on, or the aborted journal. */
  async #prepare(path: string): Promise<{ readonly branchHead: string | undefined } | Journal> {
    const options = this.#host.gitEnv !== undefined ? { base: this.#host.gitEnv } : {}
    const url = await handoffGit(path, ['config', '--get', 'remote.origin.url'], options).then((out) => out.trim(), () => '')
    const { branch, head, sessions } = this.#project
    const answer = await this.#ask('POST', 'prepare', { key: remoteKey(url), branch, head, sessionIds: sessions, to: this.#journal.peer }, PREPARE_TIMEOUT_MS)
    if (!answer.ok) return await this.#abortLocal(undefined, true)
    const body = answer.body as { branchHead?: unknown; sessions?: unknown }
    // The peer's word: a tip that is not a hash goes nowhere near a git command line.
    if (body.branchHead !== null && body.branchHead !== undefined && (typeof body.branchHead !== 'string' || !SHA.test(body.branchHead))) {
      return await this.#abortLocal('peer-error', true)
    }
    const branchHead = typeof body.branchHead === 'string' ? body.branchHead : undefined
    const digests = sessionsCheckSchema.safeParse(body.sessions)
    if (!digests.success) return await this.#abortLocal('peer-error', true)
    // 4. AGAIN, here (D7): the target ahead, and a history that went another way.
    if (branchHead !== undefined && !(await handoffGitSucceeds(path, ['merge-base', '--is-ancestor', branchHead, head], options))) {
      return await this.#abortLocal('target-ahead', true)
    }
    if ((await divergedOf(this.#host, digests.data)).size > 0) return await this.#abortLocal('history-diverged', true)
    return { branchHead }
  }

  /** Steps 5–7: the services, the code, the files. `undefined` when all of it arrived. */
  async #send(path: string, branchHead: string | undefined): Promise<Journal | undefined> {
    const { hid } = this.#journal
    // 5. The services stop AFTER prepare and BEFORE the WIP, and are named whatever happens next.
    const stopped: string[] = []
    for (const sessionId of this.#project.sessions) stopped.push(...(await this.#host.stopServices(sessionId)))
    if (stopped.length > 0) this.#host.log.info(`handoff ${hid}: stopped ${stopped.length} service(s) in ${this.#project.siteId}`)
    await this.#save({ stoppedServices: stopped })

    // 6. The code: the WIP, a fetch that only reads, the bundle.
    const env = this.#host.gitEnv
    const made = await wipCommit(path, { indexFile: join(this.#work, 'index'), hid, host: this.#journal.peer, ...(env !== undefined ? { base: env } : {}) })
    if (made.head !== this.#project.head) return await this.#abortLocal('source-changed-during-handoff', true)
    await handoffGit(path, ['fetch', '--quiet', 'origin'], env !== undefined ? { base: env } : {}).catch(() =>
      this.#host.log.warn(`handoff ${hid}: fetch origin failed in ${this.#project.siteId}; using what refs/remotes already has`),
    )
    const bundle = await makeBundle(path, { hid, head: made.head, wip: made.wip, base: handoffBase(branchHead), out: this.#bundlePath, ...(env !== undefined ? { env } : {}) })
    const bundleBytes = bundle === undefined ? 0 : (await lstat(bundle)).size
    const tooSlow = bundleBytes / (HANDOFF_ASSUMED_MBPS * 1_000_000) > HANDOFF_FILE_MAX_SECONDS
    if (bundleBytes > this.#deps.maxBundleBytes || tooSlow) return await this.#abortLocal('code-too-large', true)
    await this.#save({ phase: 'sending', head: made.head, wip: made.wip, tree: made.tree })
    return await this.#sendFiles(bundle, bundleBytes)
  }

  /** Step 7: the manifest, then every file — the bundle first. */
  async #sendFiles(bundle: string | undefined, bundleBytes: number): Promise<Journal | undefined> {
    const files = (await Promise.all(this.#project.sessions.map(async (id) => (await sessionFiles(this.#host, id)).files))).flat()
    const manifest = await buildManifest(files, bundle === undefined ? undefined : { abs: bundle, bytes: bundleBytes })
    if (manifest.entries.length > HANDOFF_MANIFEST_MAX_ENTRIES || Buffer.byteLength(JSON.stringify(manifest.entries)) > MAX_BODY_BYTES) {
      return await this.#abortLocal('too-many-files', true)
    }
    const sent = await this.#ask('POST', 'manifest', manifest.entries, HANDOFF_MANIFEST_TIMEOUT_MS)
    if (!sent.ok) return await this.#abortLocal(undefined, true)
    for (const entry of manifest.entries) {
      const timeoutMs = fileTimeoutMs(entry.bytes, entry.kind === 'git-bundle')
      const uploaded = await this.#host.peers.upload(this.#journal.peer, this.#route(`file/${entry.n}`), manifest.sources.get(entry.n) ?? '', { timeoutMs })
      await this.#heard(uploaded)
      if (!uploaded.ok) return await this.#abortLocal(undefined, true)
    }
    return undefined
  }

  /** Steps 8–15: `committing` BEFORE the commit leaves, then what its answer means. */
  async #commit(): Promise<Journal> {
    await this.#save({ phase: 'committing' })
    return await this.#settle(await this.#afterCommit(await this.#ask('POST', 'commit', {}, COMMIT_TIMEOUT_MS)))
  }

  async #settle(outcome: Outcome): Promise<Journal> {
    if (outcome === 'pending-peer') {
      this.#host.log.warn(`handoff ${this.#journal.hid}: ${this.#project.siteId} is waiting for ${this.#journal.peer} to say whether it was installed`)
      return await this.#save({ phase: 'pending-peer' })
    }
    if (outcome === 'aborted') return await this.#abortLocal(undefined, false)
    return await this.#finish()
  }

  /** Step 10: what the commit's answer means, by `handoff.reason` (D9). */
  async #afterCommit(answer: PeerResponse<unknown>): Promise<Outcome> {
    if (answer.ok) return 'committed'
    if (answer.reason === 'http' && answer.status === 404) {
      // The commit itself found no journal: the target installed nothing (v4.3).
      await this.#save({ targetReason: 'not-found' })
      return 'aborted'
    }
    if (this.#journal.targetReason === 'abort-failed') return 'aborted'
    if (answer.reason === 'http') return await this.#abortCommitting()
    return await this.#waitForStatus()
  }

  /** No answer: ask until it is known (D9). A 404 here is NOT «aborted» — it may have pruned a `committed`. */
  async #waitForStatus(): Promise<Outcome> {
    const { statusWaitMs, statusPollMs } = this.#deps
    for (let waited = 0; waited < statusWaitMs; waited += statusPollMs) {
      await this.#deps.sleep(statusPollMs)
      const outcome = await this.#askStatus()
      if (outcome !== undefined) return outcome
    }
    return 'pending-peer'
  }

  /** One `status`: its outcome, or `undefined` while it is still unknown. */
  async #askStatus(): Promise<Outcome | undefined> {
    const answer = await this.#ask('GET', 'status', undefined, NOTICE_TIMEOUT_MS)
    if (!answer.ok) return answer.reason === 'http' && answer.status === 404 ? 'pending-peer' : undefined
    const phase = (answer.body as { phase?: unknown }).phase
    if (phase === 'committed' || phase === 'done') return 'committed'
    if (phase === 'abort-failed') return 'aborted'
    if (phase === 'prepared' || phase === 'aborted') return await this.#abortCommitting()
    return undefined
  }

  /** The commit may have gone: ask the target to undo, and WAIT for its word (D9). */
  async #abortCommitting(): Promise<Outcome> {
    const answer = await this.#ask('POST', 'abort', {}, NOTICE_TIMEOUT_MS)
    if (answer.ok || (answer.reason === 'http' && answer.status === 410)) return 'aborted'
    const reason = toldOf(answer.body).targetReason
    if (answer.reason === 'http' && answer.status === 409 && reason === 'committed') return 'committed'
    if (answer.reason === 'http' && answer.status === 409 && reason === 'abort-failed') return 'aborted'
    return 'pending-peer'
  }

  /** Steps 11–15: the sessions are the other host's now; this side cleans up and tells it, once. */
  async #finish(): Promise<Journal> {
    const at = this.#host.now().toISOString()
    for (const sessionId of this.#project.sessions) await this.#host.store.patchMeta(sessionId, (meta) => ({ ...meta, movedTo: this.#journal.peer, movedAt: at }))
    await this.#save({ phase: 'acked' })
    this.#host.log.info(`handoff ${this.#journal.hid}: ${this.#project.sessions.length} session(s) of ${this.#project.siteId} moved to ${this.#journal.peer}`)
    this.#journal = await this.#deps.cleanAndRelease(this.#journal)
    return this.#journal
  }

  /**
   * An error escaped a step: what the phase says it may have left. Before `committing`, an abort here
   * that ALWAYS lets go; at `committing`, `pending-peer`; at `acked`, the cleanup once more — and if it
   * fails again, the startup's row `acked` does it.
   */
  async recover(): Promise<Journal> {
    this.#host.log.warn(`handoff ${this.#journal.hid}: a step failed in ${this.#project.siteId} (${this.#journal.phase})`)
    const phase = this.#journal.phase
    if (phase === 'locking' || phase === 'locked' || phase === 'sending') {
      return await this.#abortLocal('source-error', phase !== 'locking').catch(() => this.#journal)
    }
    if (phase === 'committing') return await this.#save({ phase: 'pending-peer' }).catch(() => this.#journal)
    if (phase === 'acked') return await this.#deps.cleanAndRelease(this.#journal).catch(() => this.#journal)
    return this.#journal
  }

  /**
   * A `pending-peer` (also one a restart made of `committing`), when the peer is back (D11, row
   * «pending-peer»): one `status`, by the table of step 10. Still unknown: it stays as it is.
   */
  async settlePending(): Promise<Journal> {
    const outcome = await this.#askStatus()
    return outcome === undefined || outcome === 'pending-peer' ? this.#journal : await this.#settle(outcome)
  }

  /** The startup's `locked` and `sending` (D11, column 2): aborted here, without the peer. */
  async abortAfterRestart(): Promise<Journal> {
    return await this.#abortLocal('restarted', false)
  }
}

