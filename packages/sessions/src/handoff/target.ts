/**
 * THE RECEIVING SIDE of a handoff (spec 2026-10-07-dos-hosts, D8, D9): `prepare`, `manifest`, each
 * `file`, `commit`, `abort`, `done` and `status`, for one project of one handoff.
 *
 * EVERY STEP OF A PROJECT GOES THROUGH ITS OWN QUEUE — the handoff's `KeyedQueue`, never the locks'
 * (D9) — so each journal has ONE writer. `status` alone reads outside it: it must answer while a long
 * `commit` holds the queue, and the journal is written atomically.
 *
 * NOTHING IS INSTALLED UNTIL THE `commit`. Until then the files wait in `staging/`, and the TTL lets
 * this host go if the source falls asleep (criterion 30b).
 */

import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isSessionId } from '../id.ts'
import { HANDOFF_HOLDER_PREFIX } from '../locks.ts'
import { parseMeta } from '../store.ts'
import type { KeyedQueue } from '../keyed-queue.ts'
import { HANDOFF_FILE_MAX_BYTES, HANDOFF_PATHS_MAX, HANDOFF_PREPARED_TTL_MS } from './constants.ts'
import { ensureBase, handoffRefPrefix, importBundle } from './git-bundle.ts'
import { handoffGit, handoffGitSucceeds, remoteKey } from './git.ts'
import type { HandoffHost } from './host.ts'
import { installSession, undoInstall, type Work } from './install.ts'
import { isHandoffId, newJournal, readJournal, writeJournal, type Journal, type Leftover } from './journal.ts'
import { logDigest } from './log-digest.ts'
import { sha256Of, validateManifest, type ManifestEntry } from './manifest.ts'
import { restoreTarget } from './restore.ts'
import { applyWip, ignoredCollisions } from './wip.ts'
import { anotherLive, hasRoom, hidIsFresh, HANDOFF_MAX_SESSIONS, HANDOFF_META_MAX_BYTES, HANDOFF_PREPARED_MAX_MS, HANDOFF_PROJECT_MAX_BYTES, localConflict, stagedExtends } from './target-checks.ts'
import { expired, invalid, notFound, ok, refuse, type TargetHandoff, type Wire } from './wire.ts'

export interface TargetDeps {
  readonly host: HandoffHost
  readonly queue: KeyedQueue
  readonly ttlMs?: number
}

export interface Target {
  readonly prepare: (hid: string, siteId: string, body: unknown) => Promise<Wire>
  readonly manifest: (hid: string, siteId: string, body: unknown) => Promise<Wire>
  readonly file: (hid: string, siteId: string, n: string, file: { readonly path: string; readonly bytes: number } | undefined) => Promise<Wire>
  readonly commit: (hid: string, siteId: string) => Promise<Wire>
  readonly abort: (hid: string, siteId: string) => Promise<Wire>
  readonly done: (hid: string, siteId: string) => Promise<Wire>
  readonly status: (hid: string, siteId: string) => Promise<Wire>
  /** The TTL of a `prepared` found at startup, re-armed by what is left of it (D11). */
  readonly rearm: (journal: Journal) => void
  /** The undo, for the startup's `installing` (D11, row «installing»). */
  readonly undo: (journal: Journal, reason: string) => Promise<Journal>
  /** Disarms every TTL. The engine's `stop()`. */
  readonly stop: () => void
}

const SHA = /^[0-9a-f]{40,64}$/
/** A branch name as `refs/heads/<branch>` can carry it, and nothing a command line could take for an option. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/
const FINAL: readonly string[] = ['aborted', 'done', 'committed', 'abort-failed']

/** What this side says in every answer: its reason, its warnings and, with a collision, the paths. */
export function handoffOf(journal: Journal): TargetHandoff {
  return {
    warnings: journal.warnings,
    ...(journal.reason !== undefined ? { reason: journal.reason } : {}),
    ...(journal.paths !== undefined ? { paths: journal.paths, pathCount: journal.pathCount ?? journal.paths.length } : {}),
  }
}

export function createTarget(deps: TargetDeps): Target {
  const { host, queue } = deps
  const ttlMs = deps.ttlMs ?? HANDOFF_PREPARED_TTL_MS
  const ttls = new Map<string, Disposable>()
  const gitOptions = host.gitEnv !== undefined ? { base: host.gitEnv } : {}
  const git = (path: string, ...args: string[]) => handoffGit(path, args, gitOptions)
  const holder = (hid: string) => `${HANDOFF_HOLDER_PREFIX}${hid}`
  const workOf = (hid: string, siteId: string): Work & { readonly root: string; readonly index: string; readonly manifest: string; readonly bundle: string } => {
    const root = host.paths.handoffWork(hid, siteId)
    return { root, staging: join(root, 'staging'), replaced: join(root, 'replaced'), index: join(root, 'index'), manifest: join(root, 'manifest.json'), bundle: join(root, 'staging', 'code.bundle') }
  }
  const pathOf = (siteId: string) => host.projects().find((project) => project.id === siteId)?.path
  const save = async (journal: Journal, patch: Partial<Journal>): Promise<Journal> => {
    const next: Journal = { ...journal, ...patch, at: host.now().toISOString() }
    await writeJournal(host.paths, next)
    return next
  }

  const disarm = (hid: string, siteId: string) => {
    ttls.get(`${hid}/${siteId}`)?.[Symbol.dispose]()
    ttls.delete(`${hid}/${siteId}`)
  }
  /** Never past HANDOFF_PREPARED_MAX_MS from `prepare`, whatever keeps arriving (security review). */
  const deadlines = new Map<string, number>()
  const arm = (hid: string, siteId: string, wanted: number) => {
    disarm(hid, siteId)
    const deadline = deadlines.get(`${hid}/${siteId}`)
    const ms = deadline === undefined ? wanted : Math.min(wanted, deadline - host.now().getTime())
    ttls.set(
      `${hid}/${siteId}`,
      host.timers.setTimeout(() => {
        void queue
          .run(siteId, async () => {
            const journal = await readJournal(host.paths, hid, siteId)
            if (journal?.phase !== 'prepared' && journal?.phase !== 'preparing') return
            host.log.warn(`handoff ${hid}: no word from the other host for ${Math.round(ttlMs / 60_000)} min; this project is let go`)
            await abortPrepared(journal)
          })
          // A timer's rejection nobody catches ends the process (code review, H1).
          .catch(() => host.log.warn(`handoff ${hid}: letting ${siteId} go after the TTL failed; the next start does it`))
      }, Math.max(0, ms)),
    )
  }

  /** `preparing` or `prepared`: the staged files and imported refs go, then the lock. */
  async function abortPrepared(journal: Journal): Promise<Journal> {
    disarm(journal.hid, journal.siteId)
    const work = workOf(journal.hid, journal.siteId)
    await rm(work.staging, { recursive: true, force: true })
    const path = pathOf(journal.siteId)
    if (path !== undefined) await deleteRefs(path, journal.hid)
    const next = await save(journal, { phase: 'aborted' })
    await host.locks.release(journal.siteId, holder(journal.hid))
    return next
  }

  async function deleteRefs(path: string, hid: string): Promise<void> {
    const refs = (await git(path, 'for-each-ref', '--format=%(refname)', `${handoffRefPrefix(hid)}/`).catch(() => '')).split('\n').filter(Boolean)
    for (const ref of refs) await git(path, 'update-ref', '-d', ref).catch(() => undefined)
  }

  /** The undo of `installing` (D9): the sessions, then the tree, then the refs. Never a pretence. */
  async function undo(journal: Journal, reason: string): Promise<Journal> {
    const work = workOf(journal.hid, journal.siteId)
    const leftovers: Leftover[] = [...(await undoInstall(host, work, journal.installed, journal.replaced))]
    const path = pathOf(journal.siteId)
    let warnings = journal.warnings
    if (path === undefined) leftovers.push({ step: 'restoreTarget' })
    else {
      try {
        const restored = await restoreTarget(path, {
          hid: journal.hid,
          branch: journal.branch ?? '',
          prevBranch: journal.prevBranch,
          prevHead: journal.prevHead ?? '',
          branchHead: journal.branchHead,
          branchCreated: journal.branchCreated === true,
          head: journal.head ?? '',
          wip: journal.wip,
          indexFile: work.index,
          ...(host.gitEnv !== undefined ? { env: host.gitEnv } : {}),
        })
        if (restored.rescued) {
          warnings = [...warnings, 'target-rescued']
          host.log.warn(`handoff ${journal.hid}: changes found here during the handoff were saved to refs/factotum/handoff-rescue/${journal.hid}`)
        }
      } catch {
        leftovers.push({ step: 'restoreTarget' })
      }
      await deleteRefs(path, journal.hid)
    }
    const failed = leftovers.length > 0
    const next = await save(journal, failed ? { phase: 'abort-failed', leftovers, reason: 'abort-failed', warnings } : { phase: 'aborted', reason, warnings })
    // Let go EVEN in abort-failed (v4.2): a lock nobody can release would close the project for ever.
    await host.locks.release(journal.siteId, holder(journal.hid))
    if (failed) host.log.warn(`handoff ${journal.hid}: the undo did not finish (${leftovers.map((l) => l.step).join(', ')}); run factotum doctor`)
    return next
  }

  /** The common checks of every step after `prepare`: ids, a journal, and not too late. */
  async function journalFor(hid: string, siteId: string): Promise<Journal | Wire> {
    if (!isHandoffId(hid)) return invalid(`"${hid}" is not a handoff id`)
    const journal = await readJournal(host.paths, hid, siteId)
    if (journal === undefined || journal.role !== 'target') return notFound('no handoff with that id for that project on this host')
    return journal
  }
  const isWire = (value: Journal | Wire): value is Wire => 'kind' in value

  async function prepare(hid: string, siteId: string, body: unknown): Promise<Wire> {
    if (!isHandoffId(hid)) return invalid(`"${hid}" is not a handoff id`)
    const path = pathOf(siteId)
    if (path === undefined) return notFound(`no project "${siteId}" on this host`)
    const input = body as { key?: unknown; branch?: unknown; head?: unknown; sessionIds?: unknown; to?: unknown } | null
    const sessionIds = input?.sessionIds
    if (typeof input?.key !== 'string' || typeof input.branch !== 'string' || !BRANCH.test(input.branch) || typeof input.head !== 'string' || !SHA.test(input.head)) {
      return invalid('prepare takes { key, branch, head, sessionIds, to }')
    }
    if (!Array.isArray(sessionIds) || sessionIds.length === 0 || sessionIds.length > HANDOFF_MAX_SESSIONS || !sessionIds.every((id) => typeof id === 'string' && isSessionId(id))) {
      return invalid('prepare takes the ids of the sessions that go')
    }
    // Its age is what the prune reads: a hid far from this clock is not one this host takes.
    if (!hidIsFresh(hid, host.now())) return invalid('that handoff id is not from now')
    const { key, branch, head } = input
    const to = typeof input.to === 'string' && /^[a-z0-9-]+$/.test(input.to) ? input.to : 'this host'

    return await queue.run(siteId, async () => {
      if ((await readJournal(host.paths, hid, siteId)) !== undefined) return refuse('target-busy', 'this handoff already reached this project')
      if (await anotherLive(host, hid)) return refuse('target-busy', 'another handoff is being received here')
      const url = await git(path, 'config', '--get', 'remote.origin.url').then((out) => out.trim(), () => '')
      if (remoteKey(url) !== key) return notFound('this project here has another remote')
      if (!(await handoffGitSucceeds(path, ['check-ref-format', '--branch', branch], gitOptions))) return invalid('that is not a branch name')
      const conflict = await localConflict(host, siteId, sessionIds as string[])
      if (conflict !== undefined) return refuse(conflict, 'a session of this handoff is this host’s own here')

      // THE JOURNAL BEFORE THE LOCK (D9): a holder `handoff-<hid>` always has a journal that explains it.
      let journal: Journal = {
        // The source's name: this host's ONE peer (design D1 allows one). The source cannot say it — a
        // module does not know its own host's name — so it says ours (`to`) instead.
        ...newJournal({ hid, siteId, role: 'target', peer: host.peers.list()[0]?.name ?? 'the other host', phase: 'preparing', at: host.now().toISOString() }),
        branch,
        head,
        sessionIds: sessionIds as string[],
        lastSignalAt: host.now().toISOString(),
        targetName: to,
      }
      await writeJournal(host.paths, journal)
      const lock = await host.locks.acquire(siteId, holder(hid), host.now().toISOString())
      if (!lock.ok) {
        await save(journal, { phase: 'aborted', reason: 'target-busy' })
        return refuse('target-busy', 'a session is working in that project here')
      }
      const status = await git(path, 'status', '--porcelain').catch(() => 'unreadable')
      if (status.trim() !== '') {
        await save(journal, { phase: 'aborted', reason: 'target-dirty' })
        await host.locks.release(siteId, holder(hid))
        return refuse('target-dirty', 'that project has uncommitted changes here')
      }
      const prevBranch = await git(path, 'symbolic-ref', '-q', '--short', 'HEAD').then((out) => out.trim() || undefined, () => undefined)
      const prevHead = (await git(path, 'rev-parse', 'HEAD')).trim()
      const branchHead = await git(path, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).then((out) => out.trim() || undefined, () => undefined)
      // The target compares nothing (D7): it digests its own copy of each session, the source decides.
      const sessions: { id: string; lines: number; sha256: string }[] = []
      for (const id of sessionIds as string[]) {
        const text = await readFile(host.paths.eventsFile(id), 'utf8').catch(() => undefined)
        if (text !== undefined) sessions.push({ id, ...logDigest(text) })
      }
      journal = await save(journal, { phase: 'prepared', prevBranch, prevHead, branchHead })
      deadlines.set(`${hid}/${siteId}`, Date.parse(journal.createdAt ?? journal.at) + HANDOFF_PREPARED_MAX_MS)
      arm(hid, siteId, ttlMs)
      return ok({ branchHead: branchHead ?? null, sessions })
    })
  }

  /** A manifest or a file is a signal: the TTL starts again (D9). */
  const signal = async (journal: Journal) => {
    arm(journal.hid, journal.siteId, ttlMs)
    return await save(journal, { lastSignalAt: host.now().toISOString() })
  }

  async function manifest(hid: string, siteId: string, body: unknown): Promise<Wire> {
    return await queue.run(siteId, async () => {
      const found = await journalFor(hid, siteId)
      if (isWire(found)) return found
      if (found.phase === 'aborted') return expired()
      if (found.phase !== 'prepared') return refuse('wrong-phase', `this project is ${found.phase} here`)
      const checked = validateManifest(body, found.sessionIds ?? [], HANDOFF_FILE_MAX_BYTES)
      if (!checked.ok) return invalid(checked.message)
      // What one project may bring, and what this disk has room for (security review).
      if (checked.entries.some((entry) => entry.kind === 'meta' && entry.bytes > HANDOFF_META_MAX_BYTES)) return invalid('a meta that size is not a session')
      const total = checked.entries.reduce((sum, entry) => sum + entry.bytes, 0)
      if (total > HANDOFF_PROJECT_MAX_BYTES) return invalid('that is more than one project may bring')
      const work = workOf(hid, siteId)
      await mkdir(work.staging, { recursive: true })
      if (!(await hasRoom(work.staging, total))) return refuse('target-full', 'this host does not have the room for it')
      await writeFile(work.manifest, JSON.stringify(checked.entries))
      const journal = await signal(found)
      // Without a bundle the target must already have the source's HEAD, or get it now (D8, step 1b).
      if (!checked.entries.some((entry) => entry.kind === 'git-bundle')) {
        const path = pathOf(siteId)
        if (path === undefined || (await ensureBase(path, { head: found.head ?? '' }, host.gitEnv)) === 'missing') {
          await save(journal, { reason: 'bundle-base-missing' })
          return refuse('bundle-base-missing', 'this host lacks the commit the other host is on, and could not fetch it')
        }
      }
      return ok({ accepted: checked.entries.length })
    })
  }

  const readManifest = async (hid: string, siteId: string): Promise<readonly ManifestEntry[] | undefined> =>
    await readFile(workOf(hid, siteId).manifest, 'utf8').then((text) => JSON.parse(text) as ManifestEntry[], () => undefined)

  const destinationOf = (work: Work, entry: ManifestEntry) => (entry.kind === 'git-bundle' ? join(work.staging, 'code.bundle') : join(work.staging, entry.sessionId ?? '', entry.rel))

  async function file(hid: string, siteId: string, n: string, received: { readonly path: string; readonly bytes: number } | undefined): Promise<Wire> {
    if (received === undefined) return invalid('this route takes the bytes of one file')
    return await queue.run(siteId, async () => {
      const found = await journalFor(hid, siteId)
      if (isWire(found)) return found
      // Too late: the file is NOT moved, so the kernel deletes it.
      if (found.phase === 'aborted') return expired()
      if (found.phase !== 'prepared') return refuse('wrong-phase', `this project is ${found.phase} here`)
      const entries = await readManifest(hid, siteId)
      const entry = entries?.find((candidate) => String(candidate.n) === n)
      if (entry === undefined) return invalid('no such file in the manifest')
      const work = workOf(hid, siteId)
      const destination = destinationOf(work, entry)
      if ((await lstat(destination).catch(() => undefined)) !== undefined) return invalid('that file already arrived')
      if (received.bytes !== entry.bytes || (await sha256Of(received.path)) !== entry.sha256) return invalid('the file is not the one the manifest names')
      if (entry.kind === 'meta') {
        const meta = parseMeta(entry.sessionId ?? '', await readFile(received.path, 'utf8').then((text) => JSON.parse(text) as unknown, () => undefined))
        if (meta === undefined || meta.state === 'running') return invalid('that meta is not a session at rest')
      }
      await mkdir(dirname(destination), { recursive: true })
      await rename(received.path, destination)
      const journal = await signal(found)
      if (entry.kind === 'git-bundle') {
        const path = pathOf(siteId)
        if (path === undefined || (await ensureBase(path, { bundle: destination }, host.gitEnv)) === 'missing') {
          await save(journal, { reason: 'bundle-base-missing' })
          return refuse('bundle-base-missing', 'this host lacks a commit the bundle needs, and could not fetch it')
        }
      }
      return ok({ received: entry.n })
    })
  }

  async function commit(hid: string, siteId: string): Promise<Wire> {
    return await queue.run(siteId, async () => {
      const found = await journalFor(hid, siteId)
      if (isWire(found)) return found
      if (found.phase === 'aborted') return expired(handoffOf(found))
      if (found.phase === 'abort-failed') return refuse('abort-failed', 'this host could not undo everything', handoffOf(found))
      if (found.phase === 'committed' || found.phase === 'done') return ok({ imported: found.sessionIds ?? [], handoff: handoffOf(found) })
      if (found.phase !== 'prepared') return refuse('wrong-phase', `this project is ${found.phase} here`)
      return await commitPrepared(found)
    })
  }

  async function commitPrepared(prepared: Journal): Promise<Wire> {
    const { hid, siteId } = prepared
    const path = pathOf(siteId)
    const work = workOf(hid, siteId)
    const entries = await readManifest(hid, siteId)
    if (path === undefined || entries === undefined) return refuse('wrong-phase', 'nothing was sent for this project')
    for (const entry of entries) {
      if ((await lstat(destinationOf(work, entry)).catch(() => undefined)) === undefined) return refuse('incomplete', 'not every file of the manifest arrived')
    }
    // AGAIN: clean, the same HEAD, the same branch (criterion 30c). Obsidian or the Git plugin may have
    // moved in between; nothing is touched if so.
    const clean = (await git(path, 'status', '--porcelain').catch(() => 'x')).trim() === ''
    const headNow = (await git(path, 'rev-parse', 'HEAD').catch(() => '')).trim()
    const branchNow = await git(path, 'symbolic-ref', '-q', '--short', 'HEAD').then((out) => out.trim() || undefined, () => undefined)
    // And the handoff's branch where prepare saw it: the undo deletes or rewinds it from what it knew then.
    const tipNow = await git(path, 'rev-parse', '--verify', '-q', `refs/heads/${prepared.branch ?? ''}`).then((out) => out.trim() || undefined, () => undefined)
    if (!clean || headNow !== prepared.prevHead || branchNow !== prepared.prevBranch || tipNow !== prepared.branchHead) {
      await save(prepared, { reason: 'target-dirty' })
      return refuse('target-dirty', 'this project changed here since prepare')
    }

    // The logs that arrived extend this host's copies, checked on the bytes (security review).
    if (!(await stagedExtends(host, work.staging, prepared.sessionIds ?? []))) {
      await save(prepared, { reason: 'history-diverged' })
      return refuse('history-diverged', 'a conversation that arrived does not continue this host’s copy')
    }
    const bundled = entries.some((entry) => entry.kind === 'git-bundle')
    if (bundled) await importBundle(path, { bundle: work.bundle, hid, ...(host.gitEnv !== undefined ? { env: host.gitEnv } : {}) })
    const wip = await git(path, 'rev-parse', '--verify', '-q', `${handoffRefPrefix(hid)}/wip`).then((out) => out.trim() || undefined, () => undefined)
    const head = prepared.head ?? ''
    const collisions = await ignoredCollisions(path, prepared.prevHead ?? '', wip ?? head, host.gitEnv !== undefined ? { env: host.gitEnv } : {})
    if (collisions.length > 0) {
      const shown = collisions.slice(0, HANDOFF_PATHS_MAX)
      const journal = await save(prepared, { reason: 'target-ignored-collision', paths: shown, pathCount: collisions.length })
      // How many, never which (criterion 36).
      host.log.warn(`handoff ${hid}: ${collisions.length} path(s) the other host would bring are ignored here and already exist; nothing was touched`)
      return refuse('target-ignored-collision', 'this host ignores files the handoff would overwrite', handoffOf(journal))
    }

    disarm(hid, siteId)
    // ONE journal for every step of `installing`: each intention is written to it before its step, so
    // a failure halfway leaves the undo exactly what was intended — the branch created included.
    let journal = await save(prepared, { phase: 'installing', wip })
    const step = async (patch: Partial<Journal>) => {
      journal = await save(journal, patch)
    }
    try {
      await installGit(path, journal, step)
      if (wip !== undefined && (await applyWip(path, wip, host.gitEnv)) !== 'applied') throw new Failure('wip-apply-failed')
      const event = { from: journal.peer, to: journal.targetName ?? 'this host', hid }
      for (const sessionId of journal.sessionIds ?? []) {
        await installSession(
          host,
          work,
          {
            intend: async (change) =>
              await step({
                installed: change.installed === undefined ? journal.installed : [...journal.installed, change.installed],
                replaced: change.replaced === undefined ? journal.replaced : [...journal.replaced, change.replaced],
              }),
            warn: async (code) => await step({ warnings: [...journal.warnings, code] }),
          },
          { sessionId, siteId, projectPath: path, event },
        )
      }
    } catch (error) {
      const reason = error instanceof Failure ? error.reason : 'install-failed'
      const undone = await undo(journal, reason)
      return refuse(undone.phase === 'abort-failed' ? 'abort-failed' : reason, 'the handoff could not be installed here, and was undone', handoffOf(undone))
    }
    // The phase BEFORE the lock goes (D9): a restart between the two finds `committed` and lets go.
    await step({ phase: 'committed' })
    await host.locks.release(siteId, holder(hid))
    return ok({ imported: journal.sessionIds ?? [], handoff: { warnings: journal.warnings } })
  }

  /** The branch, the fast-forward: the intention (`branchCreated`) written before the `checkout -b`. */
  async function installGit(path: string, journal: Journal, step: (patch: Partial<Journal>) => Promise<void>): Promise<void> {
    const branch = journal.branch ?? ''
    const head = journal.head ?? ''
    if (journal.prevBranch !== branch) {
      if (journal.branchHead !== undefined) await git(path, 'checkout', '-q', '--no-overwrite-ignore', branch, '--')
      else {
        await step({ branchCreated: true })
        await git(path, 'checkout', '-q', '--no-overwrite-ignore', '-b', branch, head, '--')
        if (await handoffGitSucceeds(path, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], gitOptions)) {
          await git(path, 'branch', `--set-upstream-to=origin/${branch}`, branch).catch(() => undefined)
        }
      }
    }
    await git(path, 'merge', '-q', '--ff-only', '--no-overwrite-ignore', head).catch(() => {
      throw new Failure('head-mismatch')
    })
    if ((await git(path, 'rev-parse', 'HEAD')).trim() !== head) throw new Failure('head-mismatch')
  }

  async function abort(hid: string, siteId: string): Promise<Wire> {
    return await queue.run(siteId, async () => {
      const found = await journalFor(hid, siteId)
      if (isWire(found)) return found
      switch (found.phase) {
        case 'aborted':
          return ok({ phase: 'aborted', handoff: handoffOf(found) })
        case 'committed':
        case 'done':
          return refuse('committed', 'this project was already installed here', handoffOf(found))
        case 'abort-failed':
          // The same reason the commit gave, and nothing touched: the undo is the owner's now (v4.3).
          return refuse('abort-failed', 'this host could not undo everything; run factotum doctor here', handoffOf(found))
        case 'installing': {
          // The journal the undo LEFT: an undo that did not finish is said so, like the commit does.
          const undone = await undo(found, 'aborted-by-source')
          if (undone.phase === 'abort-failed') return refuse('abort-failed', 'this host could not undo everything; run factotum doctor here', handoffOf(undone))
          return ok({ phase: undone.phase, handoff: handoffOf(undone) })
        }
        default:
          return ok({ phase: (await abortPrepared(found)).phase, handoff: handoffOf(found) })
      }
    })
  }

  async function done(hid: string, siteId: string): Promise<Wire> {
    return await queue.run(siteId, async () => {
      const found = await journalFor(hid, siteId)
      if (isWire(found)) return found
      if (found.phase === 'done') return ok({ phase: 'done' })
      if (found.phase !== 'committed') return refuse('wrong-phase', `this project is ${found.phase} here`)
      const work = workOf(hid, siteId)
      await rm(work.replaced, { recursive: true, force: true })
      await rm(work.staging, { recursive: true, force: true })
      const path = pathOf(siteId)
      if (path !== undefined) await deleteRefs(path, hid)
      await save(found, { phase: 'done' })
      return ok({ phase: 'done' })
    })
  }

  /** OUTSIDE THE QUEUE: it answers while a `commit` runs (D9). */
  async function status(hid: string, siteId: string): Promise<Wire> {
    const found = await journalFor(hid, siteId)
    if (isWire(found)) return found
    return ok({ phase: found.phase, handoff: handoffOf(found) })
  }

  return {
    prepare,
    manifest,
    file,
    commit,
    abort,
    done,
    status,
    rearm: (journal) => {
      const left = Date.parse(journal.lastSignalAt ?? journal.at) + ttlMs - host.now().getTime()
      if (FINAL.includes(journal.phase)) return
      arm(journal.hid, journal.siteId, left)
    },
    undo,
    stop: () => {
      for (const ttl of ttls.values()) ttl[Symbol.dispose]()
      ttls.clear()
    },
  }
}

/** A failure of `installing` with its reason (D8): what the source's report says. */
class Failure extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.reason = reason
  }
}

