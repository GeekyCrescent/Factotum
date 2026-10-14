import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { commitAll, put, sh } from '../test-repos.ts'
import { build, deliver, incoming, manualTimers, prepareBody, targetScenario, type TargetScenario } from '../test-handoff.ts'
import { uuidv7 } from '../id.ts'
import { readJournal } from './journal.ts'
import { logDigest } from './log-digest.ts'

const there = async (path: string) => (await lstat(path).catch(() => undefined)) !== undefined
const journalOf = (sc: TargetScenario) => readJournal(sc.target.host.paths, sc.hid, sc.siteId)
const holders = async (sc: TargetScenario) => (await sc.target.host.locks.holders(sc.siteId)).map((h) => h?.sessionId)

// ---------------------------------------------------------------------------
// J4 — prepare and status
// ---------------------------------------------------------------------------

test('prepare: the journal before the lock, the lock taken, prevBranch/prevHead/branchHead kept, the TTL armed, and the answer', async () => {
  const timers = manualTimers()
  const sc = await targetScenario({ timers })
  const answer = await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))
  const head = await sh(sc.w.env, sc.w.target, 'rev-parse', 'HEAD')
  assert.deepEqual(answer, { kind: 'ok', body: { branchHead: head, sessions: [] } })
  const journal = await journalOf(sc)
  assert.equal(journal?.phase, 'prepared')
  assert.equal(journal?.role, 'target')
  assert.deepEqual([journal?.prevBranch, journal?.prevHead, journal?.branchHead, journal?.branch], ['main', head, head, 'main'])
  assert.deepEqual(journal?.sessionIds, sc.sessions.map((s) => s.id))
  assert.deepEqual(await holders(sc), [`handoff-${sc.hid}`])
  assert.equal(timers.pending(), 1, 'the TTL')
})

test('prepare digests the copies this host already has (the way back): the target compares nothing (D7)', async () => {
  const sc = await targetScenario()
  const [session] = sc.sessions
  await sc.target.host.store.create({ id: session!.id, siteId: 'obsidian', entryId: 'free', startedAt: session!.startedAt, sitePath: sc.w.target, agent: undefined, prompt: 'p' })
  await sc.target.host.store.append(session!.id, { kind: 'message', role: 'user', text: 'here' })
  // It left from here: the way back (a copy this host still owned would be refused).
  await sc.target.host.store.patchMeta(session!.id, (m) => ({ ...m, state: 'finished', movedTo: 'juans-macbook-pro', movedAt: new Date().toISOString() }))
  const answer = await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))
  const text = await readFile(sc.target.host.paths.eventsFile(session!.id), 'utf8')
  assert.deepEqual(answer.kind === 'ok' ? (answer.body as { sessions: unknown }).sessions : undefined, [{ id: session!.id, ...logDigest(text) }])
})

test('a lock that loses is target-busy AT ONCE, the journal says aborted, and nothing is held', async () => {
  const sc = await targetScenario()
  const working = uuidv7(1)
  await sc.target.host.locks.acquire(sc.siteId, working, new Date().toISOString(), () => 'shared')
  const answer = await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))
  assert.deepEqual(answer.kind === 'conflict' ? answer.handoff.reason : answer.kind, 'target-busy')
  assert.equal((await journalOf(sc))?.phase, 'aborted')
  assert.deepEqual(await holders(sc), [working])
})

test('a dirty target is target-dirty, and the lock goes again', async () => {
  const sc = await targetScenario()
  await put(sc.w.target, 'a.txt', 'Obsidian wrote here\n')
  const answer = await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))
  assert.equal(answer.kind === 'conflict' ? answer.handoff.reason : answer.kind, 'target-dirty')
  assert.deepEqual(await holders(sc), [])
})

test('prepare refuses ids that are not ids, a project it does not have, another remote, and a branch a command line could misread', async () => {
  const sc = await targetScenario()
  assert.equal((await sc.t.prepare('../x', sc.siteId, await prepareBody(sc))).kind, 'invalid')
  assert.equal((await sc.t.prepare(sc.hid, 'nope', await prepareBody(sc))).kind, 'not-found')
  assert.equal((await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc, { key: 'github.com/someone/else' }))).kind, 'not-found')
  for (const branch of ['-x', 'a..b', 'a b', '']) assert.equal((await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc, { branch }))).kind, 'invalid', branch)
  assert.equal((await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc, { sessionIds: ['../x'] }))).kind, 'invalid')
  assert.equal((await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc, { head: 'HEAD' }))).kind, 'invalid')
  assert.equal(await journalOf(sc), undefined)
})

test('status answers OUTSIDE the queue, while a long task holds it', async () => {
  const sc = await targetScenario()
  await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))
  let release = () => undefined as void
  const blocker = sc.queue.run(sc.siteId, () => new Promise<void>((resolve) => (release = resolve)))
  const status = await sc.t.status(sc.hid, sc.siteId)
  assert.deepEqual(status, { kind: 'ok', body: { phase: 'prepared', handoff: { warnings: [] } } })
  release()
  await blocker
  assert.equal((await sc.t.status(uuidv7(1), sc.siteId)).kind, 'not-found')
  assert.equal((await sc.t.status('x', sc.siteId)).kind, 'invalid')
})

// ---------------------------------------------------------------------------
// J5 — manifest and files
// ---------------------------------------------------------------------------

async function prepared(options: Parameters<typeof targetScenario>[0] = {}) {
  const sc = await targetScenario(options)
  await put(sc.w.source, 'local.md', 'local commit\n')
  await commitAll(sc.w.env, sc.w.source, 'local')
  await put(sc.w.source, 'wip.md', 'half\n')
  assert.equal((await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))).kind, 'ok')
  return sc
}

test('a manifest that does not pass validateManifest is a 400 and writes nothing — also one with a session prepare did not bring (criterion 30d)', async () => {
  const sc = await prepared()
  const built = await build(sc)
  const stranger = uuidv7(7)
  const spoiled = built.entries.map((entry) => (entry.sessionId === undefined ? entry : { ...entry, sessionId: stranger, rel: entry.rel.replaceAll(entry.sessionId, stranger) }))
  assert.equal((await sc.t.manifest(sc.hid, sc.siteId, spoiled)).kind, 'invalid')
  assert.equal((await sc.t.manifest(sc.hid, sc.siteId, { not: 'a list' })).kind, 'invalid')
  assert.equal(await there(join(sc.target.host.paths.handoffWork(sc.hid, sc.siteId), 'staging')), false)
})

test('the bundle goes first (n = 0), and every file lands in staging/<sessionId>/<rel>', async () => {
  const sc = await prepared()
  const built = await build(sc)
  assert.equal(built.entries[0]?.kind, 'git-bundle')
  assert.equal((await deliver(sc, built)).kind, 'ok')
  const staging = join(sc.target.host.paths.handoffWork(sc.hid, sc.siteId), 'staging')
  const [session] = sc.sessions
  assert.deepEqual((await readdir(join(staging, session!.id), { recursive: true })).sort(), ['cli', `cli/${session!.id}.jsonl`, 'session', 'session/events.jsonl', 'session/meta.json'])
  assert.equal(await there(join(staging, 'code.bundle')), true)
})

test('a file of more, one with another hash, one twice, or a meta that is running: 400, and not in staging', async () => {
  const sc = await prepared()
  const built = await build(sc)
  assert.equal((await sc.t.manifest(sc.hid, sc.siteId, built.entries)).kind, 'ok')
  const bogus = join(sc.target.home, 'bogus')
  await writeFile(bogus, 'not the file')
  assert.equal((await sc.t.file(sc.hid, sc.siteId, '99', await incoming(sc, bogus))).kind, 'invalid')
  assert.equal((await sc.t.file(sc.hid, sc.siteId, '1', await incoming(sc, bogus))).kind, 'invalid')
  const meta = built.entries.find((entry) => entry.kind === 'meta')!
  assert.equal((await sc.t.file(sc.hid, sc.siteId, String(meta.n), await incoming(sc, built.sources.get(meta.n)!))).kind, 'ok')
  assert.equal((await sc.t.file(sc.hid, sc.siteId, String(meta.n), await incoming(sc, built.sources.get(meta.n)!))).kind, 'invalid', 'twice')
  assert.equal((await sc.t.file(sc.hid, sc.siteId, '0', undefined)).kind, 'invalid')
})

test('a meta file that parseMeta does not read, or that says running, is a 400 and does not reach staging', async () => {
  const sc = await targetScenario()
  const [session] = sc.sessions
  // The source's meta says running: a session at work never travels.
  await sc.source.host.store.patchMeta(session!.id, (m) => ({ ...m, state: 'running' }))
  await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))
  const built = await build(sc)
  await sc.t.manifest(sc.hid, sc.siteId, built.entries)
  const meta = built.entries.find((entry) => entry.kind === 'meta')!
  assert.equal((await sc.t.file(sc.hid, sc.siteId, String(meta.n), await incoming(sc, built.sources.get(meta.n)!))).kind, 'invalid')
  assert.equal(await there(join(sc.target.host.paths.handoffWork(sc.hid, sc.siteId), 'staging', session!.id, 'session', 'meta.json')), false)
})

test('NO BUNDLE, the measured case: the source pushed, the target never fetched — the manifest runs ensureBase({ head }), fetches, and passes (criterion 27b)', async () => {
  const sc = await targetScenario()
  await put(sc.w.source, 'pushed.md', 'pushed\n')
  await commitAll(sc.w.env, sc.w.source, 'pushed')
  await sh(sc.w.env, sc.w.source, 'push', '--quiet')
  await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))
  const built = await build(sc)
  assert.equal(built.entries.some((entry) => entry.kind === 'git-bundle'), false, 'nothing the remote lacks: no bundle')
  assert.equal((await deliver(sc, built)).kind, 'ok')
})

test('no bundle and a head that is nowhere: 409 bundle-base-missing before any file travels (criterion 27b)', async () => {
  const sc = await targetScenario()
  await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc, { head: 'b'.repeat(40) }))
  const built = await build(sc)
  const answer = await sc.t.manifest(sc.hid, sc.siteId, built.entries)
  assert.equal(answer.kind === 'conflict' ? answer.handoff.reason : answer.kind, 'bundle-base-missing')
})

test('a bundle without its base: 409 bundle-base-missing when it arrives', async () => {
  const sc = await prepared()
  await put(sc.w.source, 'private.md', 'never pushed\n')
  const lost = await commitAll(sc.w.env, sc.w.source, 'private')
  await put(sc.w.source, 'more-wip.md', 'half again\n')
  // As if the target had `lost`: the bundle leaves it out, and the target lacks it.
  const built = await build(sc, lost)
  await sc.t.manifest(sc.hid, sc.siteId, built.entries)
  const answer = await sc.t.file(sc.hid, sc.siteId, '0', await incoming(sc, built.sources.get(0)!))
  assert.equal(answer.kind === 'conflict' ? answer.handoff.reason : answer.kind, 'bundle-base-missing')
})

test('THE TTL RE-ARMS with every manifest and file: a 20-minute send with simulated timers does not expire (criterion 30b)', async () => {
  const timers = manualTimers()
  const sc = await prepared({ timers, ttlMs: 15 * 60_000 })
  const built = await build(sc)
  await timers.advance(10 * 60_000)
  assert.equal((await sc.t.manifest(sc.hid, sc.siteId, built.entries)).kind, 'ok')
  for (const entry of built.entries) {
    await timers.advance(10 * 60_000)
    assert.equal((await sc.t.file(sc.hid, sc.siteId, String(entry.n), await incoming(sc, built.sources.get(entry.n)!))).kind, 'ok')
  }
  assert.equal((await journalOf(sc))?.phase, 'prepared')
})

test('after the TTL: aborted, the lock let go, and a manifest or a file is 410 expired and never reaches staging (criterion 30b)', async () => {
  const timers = manualTimers()
  const sc = await prepared({ timers, ttlMs: 15 * 60_000 })
  const built = await build(sc)
  await timers.advance(15 * 60_000 + 1)
  // What the timer queued, finished: the queue runs in order.
  await sc.queue.run(sc.siteId, async () => undefined)
  assert.equal((await journalOf(sc))?.phase, 'aborted')
  assert.deepEqual(await holders(sc), [])
  assert.equal((await sc.t.manifest(sc.hid, sc.siteId, built.entries)).kind, 'expired')
  const late = await incoming(sc, built.sources.get(0)!)
  assert.equal((await sc.t.file(sc.hid, sc.siteId, '0', late)).kind, 'expired')
  assert.equal(await there(join(sc.target.host.paths.handoffWork(sc.hid, sc.siteId), 'staging', 'code.bundle')), false)
  assert.equal(await there(late.path), true, 'not moved: the kernel deletes it')
})

test('100 MB arrive with the live memory peak under 64 MB (criterion 33, the target’s side)', async () => {
  const sc = await targetScenario({ setup: async () => undefined })
  const [session] = sc.sessions
  // A 100 MB transcript on the source, written in chunks.
  const { open } = await import('node:fs/promises')
  const folder = join(sc.source.host.claudeProjects, '-somewhere')
  const handle = await open(join(folder, `${session!.id}.jsonl`), 'w')
  const chunk = Buffer.alloc(1024 * 1024, 120)
  for (let i = 0; i < 100; i += 1) await handle.write(chunk)
  await handle.close()
  await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc))
  const built = await build(sc)
  await sc.t.manifest(sc.hid, sc.siteId, built.entries)
  const big = built.entries.find((entry) => entry.kind === 'transcript')!
  const file = await incoming(sc, built.sources.get(big.n)!)
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  const memory = () => {
    gc()
    const m = process.memoryUsage()
    return m.heapUsed + m.arrayBuffers
  }
  const before = memory()
  let peak = before
  const sampler = setInterval(() => (peak = Math.max(peak, memory())), 5)
  const answer = await sc.t.file(sc.hid, sc.siteId, String(big.n), file)
  clearInterval(sampler)
  assert.equal(answer.kind, 'ok')
  assert.ok(peak - before < 64 * 1024 * 1024, `grew ${Math.round((peak - before) / 1024 / 1024)} MB`)
})
