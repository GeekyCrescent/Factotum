import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commitAll, put, sh } from '../test-repos.ts'
import { addSession, build, deliver, incoming, linked, manualTimers, prepareBody, targetScenario, type TargetScenario } from '../test-handoff.ts'
import { uuidv7 } from '../id.ts'
import { createHandoff } from './index.ts'
import { newJournal, readJournal, writeJournal, writeRun } from './journal.ts'
import { prune } from './prune.ts'
import { KeyedQueue } from '../keyed-queue.ts'
import { restoreTarget } from './restore.ts'
import { toldOf } from './source.ts'

/**
 * What the code review and the security review of the branch changed (2026-10-14), one test each. The
 * peer is the owner's other daemon with no credential (ADR-0002): its word may not take more than the
 * handoff is for.
 */

const reasonOf = (wire: { kind: string; handoff?: { reason?: string } }) => (wire.kind === 'conflict' ? wire.handoff?.reason : wire.kind)
const journalOf = (sc: TargetScenario) => readJournal(sc.target.host.paths, sc.hid, sc.siteId)

// ---------------------------------------------------------------------------
// The target's checks of the peer's word
// ---------------------------------------------------------------------------

test('a hid far from this host’s clock is refused at prepare: its age is what the prune reads', async () => {
  const sc = await targetScenario()
  const old = uuidv7(Date.now() - 3 * 24 * 3_600_000)
  assert.equal((await sc.t.prepare(old, sc.siteId, await prepareBody(sc))).kind, 'invalid')
})

test('one handoff received at a time: a second hid while the first is prepared is target-busy', async () => {
  const sc = await targetScenario()
  assert.equal((await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))).kind, 'ok')
  assert.equal(reasonOf(await sc.t.prepare(uuidv7(Date.now()), sc.siteId, await prepareBody(sc))), 'target-busy')
})

for (const [what, patch, reason] of [
  ['still this host’s (never moved away)', { state: 'finished' }, 'history-diverged'],
  ['running here', { state: 'running', movedTo: 'x' }, 'target-busy'],
  ['of another project here', { state: 'finished', movedTo: 'x', siteId: 'other' }, 'session-elsewhere'],
] as const) {
  test(`a session the peer names that is ${what} is not replaced: ${reason}, and nothing is held`, async () => {
    const sc = await targetScenario()
    const [session] = sc.sessions
    await sc.target.host.store.create({ id: session!.id, siteId: 'obsidian', entryId: 'free', startedAt: session!.startedAt, sitePath: sc.w.target, agent: undefined, prompt: 'p' })
    await sc.target.host.store.patchMeta(session!.id, (m) => ({ ...m, ...patch }))
    assert.equal(reasonOf(await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))), reason)
    assert.deepEqual(await sc.target.host.locks.holders(sc.siteId), [])
  })
}

test('the commit checks the BYTES: a log that does not continue this host’s copy is history-diverged, and nothing is touched', async () => {
  const sc = await targetScenario()
  const [session] = sc.sessions
  await sc.target.host.store.create({ id: session!.id, siteId: 'obsidian', entryId: 'free', startedAt: session!.startedAt, sitePath: sc.w.target, agent: undefined, prompt: 'p' })
  await sc.target.host.store.append(session!.id, { kind: 'message', role: 'user', text: 'only here' })
  await sc.target.host.store.patchMeta(session!.id, (m) => ({ ...m, state: 'finished', movedTo: 'juans-macbook-pro' }))
  // The source (lying, or behind) says its log extends ours; prepare cannot see the bytes.
  assert.equal((await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))).kind, 'ok')
  assert.equal((await deliver(sc, await build(sc))).kind, 'ok')
  assert.equal(reasonOf(await sc.t.commit(sc.hid, sc.siteId)), 'history-diverged')
  assert.match(JSON.stringify((await sc.target.host.store.read(session!.id, 0)).events), /only here/)
})

test('a meta over 1 MiB, or a project over 4 GiB, is refused at the manifest', async () => {
  const sc = await targetScenario()
  await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))
  const built = await build(sc)
  const fat = built.entries.map((e) => (e.kind === 'meta' ? { ...e, bytes: 2 * 1024 * 1024 } : e))
  assert.equal((await sc.t.manifest(sc.hid, sc.siteId, fat)).kind, 'invalid')
  const id = sc.sessions[0]!.id
  const huge = [
    ...built.entries,
    ...Array.from({ length: 17 }, (_, i) => ({ n: built.entries.length + i, sessionId: id, kind: 'transcript-dir-file', rel: `cli/${id}/big/${i}`, bytes: 256 * 1024 * 1024, sha256: 'a'.repeat(64) })),
  ]
  assert.equal((await sc.t.manifest(sc.hid, sc.siteId, huge)).kind, 'invalid')
})

test('THE DEADLINE: a peer that keeps sending cannot hold a project past HANDOFF_PREPARED_MAX_MS from prepare', async () => {
  const timers = manualTimers()
  const sc = await targetScenario({ timers, now: timers.clock })
  await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))
  const built = await build(sc)
  // A manifest every ten minutes re-arms the TTL; at an hour it ends anyway.
  for (let i = 0; i < 7; i += 1) {
    await timers.advance(10 * 60_000)
    await sc.t.manifest(sc.hid, sc.siteId, built.entries)
  }
  await sc.queue.run(sc.siteId, async () => undefined)
  assert.equal((await journalOf(sc))?.phase, 'aborted')
  assert.deepEqual(await sc.target.host.locks.holders(sc.siteId), [])
})

test('a branch the owner created on the target between prepare and commit: target-dirty, and the undo would not have deleted it', async () => {
  const sc = await targetScenario({ setup: async (w) => void (await sh(w.env, w.source, 'checkout', '--quiet', '-b', 'feature')) })
  await put(sc.w.source, 'wip.md', 'w\n')
  await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc, { branch: 'feature' }))
  await deliver(sc, await build(sc))
  await sh(sc.w.env, sc.w.target, 'branch', 'feature')
  assert.equal(reasonOf(await sc.t.commit(sc.hid, sc.siteId)), 'target-dirty')
  assert.notEqual(await sh(sc.w.env, sc.w.target, 'rev-parse', 'refs/heads/feature'), '')
})

test('restoreTarget with branchCreated deletes the branch only at head: one the owner made elsewhere is theirs', async () => {
  const sc = await targetScenario()
  const prevHead = await sh(sc.w.env, sc.w.target, 'rev-parse', 'HEAD')
  await sh(sc.w.env, sc.w.target, 'branch', 'feature')
  await restoreTarget(sc.w.target, { hid: sc.hid, branch: 'feature', prevBranch: 'main', prevHead, branchHead: undefined, branchCreated: true, head: 'f'.repeat(40), wip: undefined, indexFile: join(sc.target.home, 'index'), env: sc.w.env })
  assert.equal(await sh(sc.w.env, sc.w.target, 'rev-parse', 'refs/heads/feature'), prevHead)
})

test('an upload the session’s log does not name is not installed', async () => {
  const sc = await targetScenario({ sessions: 0 })
  const named = uuidv7(Date.now())
  const slipped = uuidv7(Date.now() + 1)
  for (const id of [named, slipped]) {
    await mkdir(join(sc.source.host.uploadsRoot, id), { recursive: true })
    await writeFile(join(sc.source.host.uploadsRoot, id, 'f.txt'), id)
  }
  sc.sessions.push(await addSession(sc.source, { siteId: 'vault', events: [{ kind: 'message', role: 'user', text: `@${join(sc.source.host.uploadsRoot, named, 'f.txt')}` }], transcript: 'x\n' }))
  await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))
  const built = await build(sc)
  // The source adds a file of an upload its log never names: the manifest's shape allows it.
  // The file of a second upload the log never names, with the bytes of the named one.
  const named$ = built.entries.find((e) => e.kind === 'upload')!
  const sneaky = [...built.entries, { ...named$, n: built.entries.length, rel: `uploads/${slipped}/f.txt` }]
  assert.equal((await sc.t.manifest(sc.hid, sc.siteId, sneaky)).kind, 'ok')
  for (const entry of built.entries) await sc.t.file(sc.hid, sc.siteId, String(entry.n), await incoming(sc, built.sources.get(entry.n)!))
  await writeFile(join(sc.target.home, 'same-bytes'), named)
  await sc.t.file(sc.hid, sc.siteId, String(built.entries.length), await incoming(sc, join(sc.target.home, 'same-bytes')))
  assert.equal((await sc.t.commit(sc.hid, sc.siteId)).kind, 'ok')
  const installed = (await journalOf(sc))?.installed.filter((e) => e.kind === 'upload').map((e) => e.id)
  assert.deepEqual(installed, [named])
})

test('abort on installing whose undo cannot finish answers 409 abort-failed, never ok', async () => {
  const sc = await targetScenario()
  await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))
  await deliver(sc, await build(sc))
  const journal = await journalOf(sc)
  // A replaced session the undo must bring back, and cannot: there is nothing at the source of the rename.
  await writeJournal(sc.target.host.paths, { ...journal!, phase: 'installing', replaced: [{ kind: 'transcript', id: sc.sessions[0]!.id, path: '/nonexistent/dir/that/cannot/be/made\u0000' }] })
  assert.equal(reasonOf(await sc.t.abort(sc.hid, sc.siteId)), 'abort-failed')
})

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

test('toldOf keeps what is a short code, caps the paths, and drops the rest of the peer’s word', () => {
  const told = toldOf({ handoff: { reason: 'Target Dirty\nline two', warnings: ['ok-1', 'NOT OK', 7, 'x'.repeat(50)], paths: [...Array.from({ length: 60 }, (_, i) => `p${i}`), 3], pathCount: -1 } })
  assert.equal(told.targetReason, undefined)
  assert.deepEqual(told.warnings, ['ok-1'])
  assert.equal(told.targetPaths?.length, 50)
  assert.equal(told.targetPathCount, undefined)
  assert.deepEqual(toldOf(undefined), { warnings: [] })
  assert.equal(toldOf({ handoff: { reason: 'target-dirty', warnings: [] } }).targetReason, 'target-dirty')
})

test('two POST /handoff at once: one starts, the other is told one is going on', async () => {
  const l = await linked({ handoff: { source: { sleep: async () => undefined, statusWaitMs: 10, statusPollMs: 5 } } })
  await addSession(l.mac, { siteId: 'vault', transcript: 'x\n' })
  const [a, b] = await Promise.all([l.mac.api.start({ to: 'omarchy' }), l.mac.api.start({ to: 'omarchy' })])
  assert.deepEqual([a.kind, b.kind].sort(), ['conflict', 'ok'])
  await l.mac.api.settled()
})

test('a prepare answer whose branchHead is not a hash goes nowhere near git: peer-error', async () => {
  const l = await linked({ handoff: { source: { sleep: async () => undefined, statusWaitMs: 10, statusPollMs: 5 } } })
  await put(l.w.source, 'a.txt', 'changed\n')
  await addSession(l.mac, { siteId: 'vault', transcript: 'x\n' })
  const next = l.toOmarchy.route!
  l.toOmarchy.route = async (method, path, body, file) => {
    const answer = await next(method, path, body, file)
    return path.endsWith('/prepare') && answer?.kind === 'ok' ? { kind: 'ok', body: { ...(answer.body as object), branchHead: '--output=/tmp/x' } } : answer
  }
  const started = await l.mac.api.start({ to: 'omarchy' })
  await l.mac.api.settled()
  const hid = started.kind === 'ok' ? (started.body as { hid: string }).hid : ''
  const journal = await readJournal(l.mac.host.paths, hid, 'vault')
  assert.deepEqual([journal?.phase, journal?.reason], ['aborted', 'peer-error'])
})

test('nothing of the background throws out of it: a restart step that fails is logged, and the others go on', async () => {
  const l = await linked()
  const broken = uuidv7(Date.now())
  const fine = uuidv7(Date.now() + 1)
  // One `acked` whose project is gone from this host, and one `locked` that aborts normally.
  await writeJournal(l.mac.host.paths, { ...newJournal({ hid: broken, siteId: 'vault', role: 'source', peer: 'omarchy', phase: 'acked', at: new Date().toISOString() }), peerSiteId: 'obsidian', head: 'a'.repeat(40), tree: 'b'.repeat(40) })
  await writeJournal(l.mac.host.paths, { ...newJournal({ hid: fine, siteId: 'vault', role: 'source', peer: 'omarchy', phase: 'locked', at: new Date().toISOString() }), peerSiteId: 'obsidian' })
  const again = createHandoff({ ...l.mac.host, store: new Proxy(l.mac.host.store, {}) })
  await again.atStart()
  await again.afterStart()
  assert.equal((await readJournal(l.mac.host.paths, fine, 'vault'))?.phase, 'aborted')
})

test('the prune ages by THIS host’s clock: a run still planning (no journal yet) keeps its folder; a backup made today survives an old hid', async () => {
  const l = await linked()
  const hid = uuidv7(Date.now() - 20 * 24 * 3_600_000)
  await writeRun(l.mac.host.paths, { hid, peer: 'omarchy', startedAt: new Date().toISOString(), siteIds: [], state: 'planning' })
  const head = await sh(l.w.env, l.w.source, 'rev-parse', 'HEAD')
  await sh(l.w.env, l.w.source, 'update-ref', `refs/factotum/handoff-rescue/${hid}`, (await commitAll(l.w.env, l.w.source, 'today').catch(() => head)) || head)
  await prune(l.mac.host, new KeyedQueue())
  assert.notEqual(await readJournal(l.mac.host.paths, hid, 'vault').then(() => 'x'), undefined)
  assert.match(await sh(l.w.env, l.w.source, 'for-each-ref', 'refs/factotum/'), new RegExp(hid))
})
