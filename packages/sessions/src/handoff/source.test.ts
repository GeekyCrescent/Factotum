import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PeerResponse } from '@factotum/core'
import { commitAll, put, sh } from '../test-repos.ts'
import { addSession, linked, type Linked, type Route, type Wire } from '../test-handoff.ts'
import type { HandoffOptions } from './index.ts'
import { readJournal, listJournals } from './journal.ts'

/** Fast waits: the status loop polls every 5 ms, for 50 ms. */
const FAST: HandoffOptions = { source: { sleep: async () => undefined, statusWaitMs: 50, statusPollMs: 5 } }

type Hook = (method: 'GET' | 'POST', path: string, body: unknown, file: string | undefined, next: Route) => Promise<Wire | undefined>

/** Every call from the Mac to omarchy goes through `hook` first. */
function intercept(l: Linked, hook: Hook): void {
  const next = l.toOmarchy.route!
  l.toOmarchy.route = (method, path, body, file) => hook(method, path, body, file, next)
}

async function scene(options: { readonly setup?: NonNullable<Parameters<typeof linked>[0]>['setup']; readonly handoff?: HandoffOptions } = {}) {
  const l = await linked({ ...(options.setup !== undefined ? { setup: options.setup } : {}), handoff: { ...FAST, ...options.handoff } })
  await put(l.w.source, 'local.md', 'local\n')
  await commitAll(l.w.env, l.w.source, 'local')
  await put(l.w.source, 'a.txt', 'changed\n')
  const session = await addSession(l.mac, { siteId: 'vault', transcript: '{"t":1}\n' })
  const before = {
    remote: await sh(l.w.env, l.w.source, 'ls-remote', 'origin'),
    sourceStatus: await sh(l.w.env, l.w.source, 'status', '--porcelain'),
    sourceHead: await sh(l.w.env, l.w.source, 'rev-parse', 'HEAD'),
    targetHead: await sh(l.w.env, l.w.target, 'rev-parse', 'HEAD'),
  }
  return { l, session, before }
}

async function go(l: Linked) {
  const started = await l.mac.api.start({ to: 'omarchy' })
  const hid = started.kind === 'ok' ? (started.body as { hid: string }).hid : ''
  await l.mac.api.settled()
  const source = await readJournal(l.mac.host.paths, hid, 'vault')
  const target = await readJournal(l.omarchy.host.paths, hid, 'obsidian')
  return { hid, source, target }
}

/** Both sides as they were: nothing moved on the source, nothing installed on the target, the remote untouched. */
async function asBefore(s: Awaited<ReturnType<typeof scene>>) {
  const { l, session, before } = s
  assert.equal(await sh(l.w.env, l.w.source, 'ls-remote', 'origin'), before.remote, 'the remote never moves')
  assert.equal(await sh(l.w.env, l.w.source, 'status', '--porcelain'), before.sourceStatus, 'the source tree is not cleaned')
  assert.equal(await sh(l.w.env, l.w.source, 'rev-parse', 'HEAD'), before.sourceHead)
  assert.equal(await sh(l.w.env, l.w.target, 'rev-parse', 'HEAD'), before.targetHead)
  assert.equal(await sh(l.w.env, l.w.target, 'status', '--porcelain'), '')
  assert.equal((await l.mac.host.store.readMeta(session.id))?.movedTo, undefined)
  assert.equal(await l.omarchy.host.store.readMeta(session.id), undefined)
  assert.deepEqual(await l.mac.host.locks.holders('vault'), [])
  assert.deepEqual(await l.omarchy.host.locks.holders('obsidian'), [])
  assert.equal(await sh(l.w.env, l.w.source, 'for-each-ref', 'refs/factotum/handoff/'), '')
}

type Json = (peer: string, method: 'GET' | 'POST', path: string, body?: unknown, options?: { readonly timeoutMs?: number }) => Promise<PeerResponse<unknown>>

/** The Mac's calls to omarchy, seen and rewritten at the `PeerCaller`, as a lost answer looks. */
function overrideJson(l: Linked, wrap: (json: Json) => Json): void {
  const peers = l.mac.host.peers as { json: Json }
  peers.json = wrap(peers.json.bind(peers))
}

const reject = (reason: string): Wire => ({ kind: 'conflict', message: reason, handoff: { reason, warnings: [] } })

// ---------------------------------------------------------------------------
// J12a — what the SOURCE decides, before the commit: aborted here, without waiting for the peer
// ---------------------------------------------------------------------------

test('a lock taken on the source between the plan and the handoff: project-busy, and the peer never hears of it', async () => {
  const s = await scene()
  intercept(s.l, async (method, path, body, file, next) => {
    // While the plan asks omarchy, a session starts in the vault.
    if (path === 'handoff/projects') await s.l.mac.host.locks.acquire('vault', '0199e0c0-0000-7000-8000-00000000beef', new Date().toISOString())
    if (path.endsWith('/prepare')) assert.fail('prepare must not be sent')
    return await next(method, path, body, file)
  })
  const { source } = await go(s.l)
  assert.deepEqual([source?.phase, source?.reason], ['aborted', 'project-busy'])
  await s.l.mac.host.locks.release('vault', '0199e0c0-0000-7000-8000-00000000beef')
  await asBefore(s)
})

test('the target ahead, by prepare’s answer: target-ahead, aborted here, and the target told once', async () => {
  const s = await scene()
  const sent: string[] = []
  intercept(s.l, async (method, path, body, file, next) => {
    sent.push(path.split('/').at(-1) ?? '')
    const answer = await next(method, path, body, file)
    if (path.endsWith('/prepare') && answer?.kind === 'ok') return { kind: 'ok', body: { ...(answer.body as object), branchHead: 'c'.repeat(40) } }
    return answer
  })
  const { source, target } = await go(s.l)
  assert.deepEqual([source?.phase, source?.reason], ['aborted', 'target-ahead'])
  assert.equal(target?.phase, 'aborted')
  assert.deepEqual(sent.slice(-2), ['prepare', 'abort'])
  await asBefore(s)
})

test('a history that went another way on the target, found at prepare: history-diverged (step 4)', async () => {
  const s = await scene()
  intercept(s.l, async (method, path, body, file, next) => {
    if (path.endsWith('/prepare')) {
      // Between the plan and prepare, omarchy gets its own copy of the session, which went elsewhere.
      await s.l.omarchy.host.store.create({ id: s.session.id, siteId: 'obsidian', entryId: 'free', startedAt: s.session.startedAt, sitePath: s.l.w.target, agent: undefined, prompt: 'p' })
      await s.l.omarchy.host.store.append(s.session.id, { kind: 'message', role: 'user', text: 'elsewhere' })
    }
    return await next(method, path, body, file)
  })
  const { source } = await go(s.l)
  assert.deepEqual([source?.phase, source?.reason], ['aborted', 'history-diverged'])
})

test('the services are stopped after prepare and before the WIP, and named in the report — also when the project is then aborted (criterion 34)', async () => {
  const s = await scene({ handoff: { source: { ...FAST.source, maxBundleBytes: 1 } } })
  const order: string[] = []
  ;(s.l.mac.host as { stopServices: (id: string) => Promise<readonly string[]> }).stopServices = async (id) => (s.l.mac.stopped.push(id), ['s1'])
  intercept(s.l, async (method, path, body, file, next) => {
    order.push(path.split('/').at(-1) ?? '')
    return await next(method, path, body, file)
  })
  const { hid, source } = await go(s.l)
  // `code-too-large`: the bundle is over the (lowered) ceiling.
  assert.deepEqual([source?.phase, source?.reason], ['aborted', 'code-too-large'])
  assert.deepEqual(s.l.mac.stopped, [s.session.id], 'stopServices ran for the session')
  const report = await s.l.mac.api.report(hid)
  assert.deepEqual(report.kind === 'ok' ? (report.body as { projects: { stoppedServices: unknown }[] }).projects[0]?.stoppedServices : undefined, ['s1'])
  assert.deepEqual(order.slice(-2), ['prepare', 'abort'])
  await asBefore(s)
})

test('a file that does not arrive: aborted here, the target told, and its staging gone', async () => {
  const s = await scene()
  intercept(s.l, async (method, path, body, file, next) => (path.endsWith('/file/1') ? undefined : await next(method, path, body, file)))
  const { source, target } = await go(s.l)
  assert.equal(source?.phase, 'aborted')
  assert.equal(target?.phase, 'aborted')
  await asBefore(s)
})

test('THE ABORT BEFORE THE COMMIT IS LOCAL: with the peer gone after prepare, the source ends aborted — never pending-peer — and lets go', async () => {
  const s = await scene()
  intercept(s.l, async (method, path, body, file, next) => {
    const answer = await next(method, path, body, file)
    if (path.endsWith('/prepare')) s.l.toOmarchy.reachable = false
    return answer
  })
  const { source, target } = await go(s.l)
  assert.equal(source?.phase, 'aborted')
  assert.deepEqual(await s.l.mac.host.locks.holders('vault'), [])
  // The target's side is the TTL's: still prepared, with its lock.
  assert.equal(target?.phase, 'prepared')
})

test('a fetch that fails does not stop anything: the handoff goes on with the refs/remotes it has', async () => {
  const s = await scene()
  intercept(s.l, async (method, path, body, file, next) => {
    if (path.endsWith('/prepare')) await sh(s.l.w.env, s.l.w.source, 'remote', 'set-url', 'origin', join(s.l.w.home, 'gone.git'))
    return await next(method, path, body, file)
  })
  const { source } = await go(s.l)
  assert.equal(source?.phase, 'done')
  assert.match(s.l.mac.lines.join('\n'), /fetch origin failed/)
})

test('a step that throws on the source aborts like a refusal: nothing escapes with the lock held', async () => {
  const s = await scene()
  const { l } = s
  ;(l.mac.host as { stopServices: (sessionId: string) => Promise<readonly string[]> }).stopServices = async () => {
    throw new Error('the service would not die')
  }
  const { source, target } = await go(l)
  assert.deepEqual([source?.phase, source?.reason], ['aborted', 'source-error'])
  assert.equal(target?.phase, 'aborted')
  assert.deepEqual(await l.mac.host.locks.holders('vault'), [])
})

// ---------------------------------------------------------------------------
// J12b — what the TARGET refuses: the reason reaches the report
// ---------------------------------------------------------------------------

test('target-dirty at the commit (Obsidian wrote meanwhile): aborted on both sides, the reason in the source’s journal (criterion 30c)', async () => {
  const s = await scene()
  intercept(s.l, async (method, path, body, file, next) => {
    if (path.endsWith('/commit')) await writeFile(join(s.l.w.target, 'a.txt'), 'Obsidian\n')
    return await next(method, path, body, file)
  })
  const { source, target } = await go(s.l)
  assert.deepEqual([source?.phase, source?.targetReason], ['aborted', 'target-dirty'])
  assert.equal(target?.phase, 'aborted')
  assert.equal(await readFile(join(s.l.w.target, 'a.txt'), 'utf8'), 'Obsidian\n', 'the owner’s edit stays')
  assert.equal(await sh(s.l.w.env, s.l.w.source, 'ls-remote', 'origin'), s.before.remote)
})

test('target-ignored-collision: the owner’s ignored file on the target stays as it was, and its path reaches the source’s report (criterion 27c)', async () => {
  const s = await scene({
    setup: async (w) => {
      await writeFile(join(w.target, '.git', 'info', 'exclude'), 'secret.local\n')
      await put(w.target, 'secret.local', 'the target’s own\n')
    },
  })
  await put(s.l.w.source, 'secret.local', 'from the source\n')
  const { hid, source } = await go(s.l)
  assert.deepEqual([source?.phase, source?.targetReason, source?.targetPaths], ['aborted', 'target-ignored-collision', ['secret.local']])
  assert.equal(await readFile(join(s.l.w.target, 'secret.local'), 'utf8'), 'the target’s own\n')
  const report = await s.l.mac.api.report(hid)
  assert.deepEqual(report.kind === 'ok' ? (report.body as { projects: { targetPaths: unknown }[] }).projects[0]?.targetPaths : undefined, ['secret.local'])
  await asBefore({ ...s, before: { ...s.before, sourceStatus: await sh(s.l.w.env, s.l.w.source, 'status', '--porcelain') } })
})

test('bundle-base-missing WITHOUT a bundle (the measured case, with the remote gone for the target): aborted before any file, the reason reported (criterion 27b)', async () => {
  const s = await scene()
  // Nothing local on the source: its HEAD is pushed, so no bundle; the target cannot fetch it.
  await sh(s.l.w.env, s.l.w.source, 'checkout', '--quiet', '--', '.')
  await sh(s.l.w.env, s.l.w.source, 'push', '--quiet')
  intercept(s.l, async (method, path, body, file, next) => {
    // After prepare checked the remote, the target loses it: its fetch for the missing HEAD fails.
    if (path.endsWith('/manifest')) await sh(s.l.w.env, s.l.w.target, 'remote', 'set-url', 'origin', join(s.l.w.home, 'gone.git'))
    if (path.includes('/file/')) assert.fail('no file travels before the base is known')
    return await next(method, path, body, file)
  })
  const { source } = await go(s.l)
  assert.deepEqual([source?.phase, source?.targetReason], ['aborted', 'bundle-base-missing'])
})

test('a wip-apply-failed (an untracked, not ignored, file in the way, put there mid-commit): undone on the target, reported on the source', async () => {
  const s = await scene()
  await put(s.l.w.source, 'new.md', 'from the source\n')
  // The target refuses the commit as if applyWip had failed (its own undo is J7's): the source asks it
  // to undo, and its prepared side goes.
  intercept(s.l, async (method, path, body, file, next) => (path.endsWith('/commit') ? reject('wip-apply-failed') : await next(method, path, body, file)))
  const { source, target } = await go(s.l)
  assert.deepEqual([source?.phase, source?.targetReason], ['aborted', 'wip-apply-failed'])
  // The commit "answered" without running: the source asked the target to undo, and it did.
  assert.equal(target?.phase, 'aborted')
})

// ---------------------------------------------------------------------------
// J13 — around the commit
// ---------------------------------------------------------------------------

test('a commit that answers nothing but did its work: the source does not abort, asks status, and goes on (criterion 30)', async () => {
  const s = await scene()
  // The commit runs on the target, and its answer is lost on the way back: a timeout here.
  overrideJson(s.l, (json) => async (peer, method, path, body, options) => {
    const answer = await json(peer, method, path, body, options)
    return path.endsWith('/commit') ? { ok: false, status: undefined, reason: 'timeout', body: undefined } : answer
  })
  const { source, target } = await go(s.l)
  assert.equal(target?.phase, 'done')
  assert.equal(source?.phase, 'done')
  assert.equal((await s.l.mac.host.store.readMeta(s.session.id))?.movedTo, 'omarchy')
})

test('the commit’s answer lost, then status says 404 (the target pruned it): pending-peer with the lock, never aborted; «Keep them here» lets go (criteria 30, 32b)', async () => {
  const s = await scene()
  overrideJson(s.l, (json) => async (peer, method, path, body, options) => {
    if (path.endsWith('/commit')) return { ok: false, status: undefined, reason: 'timeout', body: undefined }
    if (path.endsWith('/status')) return { ok: false, status: 404, reason: 'http', body: { error: { code: 'not-found', message: 'gone' } } }
    return await json(peer, method, path, body, options)
  })
  const { hid, source } = await go(s.l)
  assert.equal(source?.phase, 'pending-peer')
  assert.deepEqual((await s.l.mac.host.locks.holders('vault')).map((h) => h?.sessionId), [`handoff-${hid}`])
  assert.equal((await s.l.mac.api.keep(hid, 'vault')).kind, 'ok')
  assert.equal((await readJournal(s.l.mac.host.paths, hid, 'vault'))?.phase, 'kept')
  assert.deepEqual(await s.l.mac.host.locks.holders('vault'), [])
  assert.equal((await s.l.mac.host.store.readMeta(s.session.id))?.movedTo, undefined, 'no movedTo, and the tree untouched')
  assert.notEqual(await sh(s.l.w.env, s.l.w.source, 'status', '--porcelain'), '')
  const again = await s.l.mac.api.keep(hid, 'vault')
  assert.equal(again.kind === 'conflict' ? again.handoff.reason : again.kind, 'wrong-phase')
})

test('a 404 to the COMMIT itself: the target had no journal, installed nothing — aborted here, with not-found, never pending-peer (v4.3)', async () => {
  const s = await scene()
  intercept(s.l, async (method, path, body, file, next) => (path.endsWith('/commit') ? { kind: 'not-found', message: 'no journal' } : await next(method, path, body, file)))
  const { source } = await go(s.l)
  assert.deepEqual([source?.phase, source?.targetReason], ['aborted', 'not-found'])
  assert.deepEqual(await s.l.mac.host.locks.holders('vault'), [])
})

test('abort-failed in the commit’s answer: aborted here WITHOUT sending abort, and the report says run doctor there (criterion 32d)', async () => {
  const s = await scene()
  const sent: string[] = []
  intercept(s.l, async (method, path, body, file, next) => {
    sent.push(path.split('/').at(-1) ?? '')
    return path.endsWith('/commit') ? reject('abort-failed') : await next(method, path, body, file)
  })
  const { source } = await go(s.l)
  assert.deepEqual([source?.phase, source?.targetReason], ['aborted', 'abort-failed'])
  assert.equal(sent.includes('abort'), false)
})

test('an abort answered 409 committed: the source goes on from step 11; one answered 409 abort-failed: aborted here (J13)', async () => {
  const committed = await scene()
  intercept(committed.l, async (method, path, body, file, next) => {
    if (path.endsWith('/commit')) {
      await next(method, path, body, file)
      return reject('wip-apply-failed')
    }
    return await next(method, path, body, file)
  })
  const first = await go(committed.l)
  assert.equal(first.source?.phase, 'done', 'the target said committed to the abort')
  assert.equal((await committed.l.mac.host.store.readMeta(committed.session.id))?.movedTo, 'omarchy')

  const failed = await scene()
  intercept(failed.l, async (method, path, body, file, next) => {
    if (path.endsWith('/commit')) return reject('wip-apply-failed')
    if (path.endsWith('/abort')) return reject('abort-failed')
    return await next(method, path, body, file)
  })
  const second = await go(failed.l)
  assert.deepEqual([second.source?.phase, second.source?.targetReason], ['aborted', 'abort-failed'])
})

test('a commit after the target’s TTL: 410 expired, and the report says so (criterion 30b)', async () => {
  const s = await scene()
  intercept(s.l, async (method, path, body, file, next) => (path.endsWith('/commit') ? { kind: 'expired', handoff: { reason: 'expired', warnings: [] } } : await next(method, path, body, file)))
  const { source } = await go(s.l)
  assert.deepEqual([source?.phase, source?.targetReason], ['aborted', 'expired'])
})

test('a done that never arrives does not keep anything: the source is done and has let go (v4.1)', async () => {
  const s = await scene()
  intercept(s.l, async (method, path, body, file, next) => (path.endsWith('/done') ? undefined : await next(method, path, body, file)))
  const { source, target } = await go(s.l)
  assert.equal(source?.phase, 'done')
  assert.equal(target?.phase, 'committed', 'its leftovers are the prune’s now')
  assert.deepEqual(await s.l.mac.host.locks.holders('vault'), [])
})

test('the source changed during the handoff: not cleaned, the WIP backed up, and the report says source-changed-during-handoff (criterion 31)', async () => {
  const s = await scene()
  intercept(s.l, async (method, path, body, file, next) => {
    const answer = await next(method, path, body, file)
    if (path.endsWith('/commit')) await put(s.l.w.source, 'late.md', 'typed after the WIP\n')
    return answer
  })
  const { hid, source } = await go(s.l)
  assert.deepEqual([source?.phase, source?.warnings], ['done', ['source-changed-during-handoff']])
  assert.equal(await readFile(join(s.l.w.source, 'late.md'), 'utf8'), 'typed after the WIP\n')
  assert.notEqual(await sh(s.l.w.env, s.l.w.source, 'rev-parse', `refs/factotum/handoff-backup/${hid}`), '')
  assert.equal((await listJournals(s.l.mac.host.paths, hid)).length, 1)
})

// ---------------------------------------------------------------------------
// The status loop, answer by answer (D9, step 10)
// ---------------------------------------------------------------------------

/** The commit's answer lost; `status` answers from `answers`, one per poll, then the last for ever. */
function lostCommit(s: Awaited<ReturnType<typeof scene>>, answers: readonly PeerResponse<unknown>[], abort?: PeerResponse<unknown>) {
  let n = 0
  overrideJson(s.l, (json) => async (peer, method, path, body, options) => {
    if (path.endsWith('/commit')) {
      void json(peer, method, path, body, options)
      return { ok: false, status: undefined, reason: 'timeout', body: undefined }
    }
    if (path.endsWith('/status')) return answers[Math.min(n++, answers.length - 1)]!
    if (path.endsWith('/abort') && abort !== undefined) return abort
    return await json(peer, method, path, body, options)
  })
}

const phase = (name: string): PeerResponse<unknown> => ({ ok: true, status: 200, body: { phase: name, handoff: { warnings: [] } } })
const gone: PeerResponse<unknown> = { ok: false, status: undefined, reason: 'unreachable', body: undefined }

test('status says installing, then committed: the source waits, then goes on', async () => {
  const s = await scene()
  lostCommit(s, [phase('installing'), phase('installing'), phase('committed')])
  const { source } = await go(s.l)
  assert.equal(source?.phase, 'done')
})

test('status says abort-failed: aborted here, without sending abort', async () => {
  const s = await scene()
  lostCommit(s, [{ ok: true, status: 200, body: { phase: 'abort-failed', handoff: { reason: 'abort-failed', warnings: [] } } }])
  const { source } = await go(s.l)
  assert.deepEqual([source?.phase, source?.targetReason], ['aborted', 'abort-failed'])
})

test('status never knows: pending-peer when the wait runs out, with the lock', async () => {
  const s = await scene()
  lostCommit(s, [gone])
  const { hid, source } = await go(s.l)
  assert.equal(source?.phase, 'pending-peer')
  assert.deepEqual((await s.l.mac.host.locks.holders('vault')).map((h) => h?.sessionId), [`handoff-${hid}`])
})

test('status says prepared, and the abort that follows gets no answer: pending-peer, never a guess', async () => {
  const s = await scene()
  lostCommit(s, [phase('prepared')], gone)
  const { source } = await go(s.l)
  assert.equal(source?.phase, 'pending-peer')
})

test('a pending-peer whose peer is still silent stays as it is when polled', async () => {
  const s = await scene()
  lostCommit(s, [gone])
  const { hid } = await go(s.l)
  await s.l.mac.api.poll()
  assert.equal((await readJournal(s.l.mac.host.paths, hid, 'vault'))?.phase, 'pending-peer')
})
