import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commitAll, indexPath, put, sh } from '../test-repos.ts'
import { addSession, build, deliver, manualTimers, prepareBody, targetScenario, type Built, type TargetScenario } from '../test-handoff.ts'
import { KeyedQueue } from '../keyed-queue.ts'
import { uuidv7 } from '../id.ts'
import type { SessionStore } from '../store.ts'
import { cliDirOf } from './cli-paths.ts'
import { readJournal } from './journal.ts'
import { createTarget } from './target.ts'
import { wipTree } from './wip.ts'

const there = async (path: string) => (await lstat(path).catch(() => undefined)) !== undefined
const journalOf = (sc: TargetScenario) => readJournal(sc.target.host.paths, sc.hid, sc.siteId)
const holders = async (sc: TargetScenario) => (await sc.target.host.locks.holders(sc.siteId)).map((h) => h?.sessionId)
const refsOf = (sc: TargetScenario) => sh(sc.w.env, sc.w.target, 'for-each-ref', 'refs/factotum/')
const reasonOf = (wire: Awaited<ReturnType<TargetScenario['t']['commit']>>) => (wire.kind === 'conflict' || wire.kind === 'expired' ? wire.handoff.reason : wire.kind)

/** A local commit, a change, an untracked file and a staged one: what the owner leaves before going. */
async function work(sc: TargetScenario) {
  await put(sc.w.source, 'local.md', 'local commit\n')
  await commitAll(sc.w.env, sc.w.source, 'local')
  await put(sc.w.source, 'a.txt', 'changed\n')
  await put(sc.w.source, 'new.md', 'new\n')
  await put(sc.w.source, 'staged.md', 'staged\n')
  await sh(sc.w.env, sc.w.source, 'add', 'staged.md')
}

async function sent(sc: TargetScenario, over: Record<string, unknown> = {}): Promise<Built> {
  assert.equal((await sc.t.prepare(sc.hid, sc.siteId, await prepareBody(sc, over))).kind, 'ok')
  const built = await build(sc)
  assert.equal((await deliver(sc, built)).kind, 'ok')
  return built
}

async function snapshot(sc: TargetScenario) {
  return {
    head: await sh(sc.w.env, sc.w.target, 'rev-parse', 'HEAD'),
    status: await sh(sc.w.env, sc.w.target, 'status', '--porcelain', '--ignored'),
    heads: await sh(sc.w.env, sc.w.target, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'),
    sessions: (await readdir(sc.target.host.paths.sessions)).sort(),
    projects: await readdir(sc.target.host.claudeProjects, { recursive: true }).then((names) => names.sort(), () => []),
  }
}

// ---------------------------------------------------------------------------
// J6a — the commit, its git
// ---------------------------------------------------------------------------

test('a good commit: the same commit on the same branch, the WIP as uncommitted changes, the sessions with THIS host’s meta, one handoff event (criteria 24-26)', async () => {
  const sc = await targetScenario({ sessions: 2 })
  await work(sc)
  const built = await sent(sc)
  const answer = await sc.t.commit(sc.hid, sc.siteId)
  assert.deepEqual(answer, { kind: 'ok', body: { imported: sc.sessions.map((s) => s.id), handoff: { warnings: [] } } })

  assert.equal(await sh(sc.w.env, sc.w.target, 'rev-parse', 'HEAD'), built.head)
  assert.equal(await sh(sc.w.env, sc.w.target, 'symbolic-ref', '--short', 'HEAD'), 'main')
  assert.equal(await wipTree(sc.w.target, { indexFile: await indexPath(sc.w), base: sc.w.env }), built.tree)
  assert.equal(await sh(sc.w.env, sc.w.target, 'diff', '--cached', '--name-only'), '', 'nothing staged')

  for (const session of sc.sessions) {
    const meta = await sc.target.host.store.readMeta(session.id)
    assert.deepEqual([meta?.siteId, meta?.sitePath, meta?.movedTo, meta?.entryId, meta?.touchedAt], ['obsidian', sc.w.target, undefined, session.entryId, session.touchedAt])
    const events = (await sc.target.host.store.read(session.id, 0)).events
    assert.deepEqual(events.at(-1), { ...events.at(-1), kind: 'handoff', from: 'mac', to: 'omarchy', hid: sc.hid })
    assert.equal(events.filter((e) => e.kind === 'handoff').length, 1)
    assert.equal(await there(join(sc.target.host.claudeProjects, await cliDirOf(sc.w.target), `${session.id}.jsonl`)), true)
  }
  assert.equal((await journalOf(sc))?.phase, 'committed')
  assert.deepEqual(await holders(sc), [])
  // Idempotent: a commit that arrives twice answers what it did.
  assert.equal((await sc.t.commit(sc.hid, sc.siteId)).kind, 'ok')
})

test('the second check: a file edited on the target between prepare and commit is target-dirty, and NOTHING is touched (criterion 30c)', async () => {
  const sc = await targetScenario()
  await work(sc)
  await sent(sc)
  await put(sc.w.target, 'a.txt', 'Obsidian, mid-handoff\n')
  const before = await snapshot(sc)
  assert.equal(reasonOf(await sc.t.commit(sc.hid, sc.siteId)), 'target-dirty')
  assert.deepEqual(await snapshot(sc), before)
  assert.equal((await journalOf(sc))?.phase, 'prepared')
})

test('the second check: a commit made on the target meanwhile (the Git plugin) is target-dirty too (criterion 30c)', async () => {
  const sc = await targetScenario()
  await work(sc)
  await sent(sc)
  await sh(sc.w.env, sc.w.target, 'commit', '--quiet', '--allow-empty', '-m', 'plugin')
  assert.equal(reasonOf(await sc.t.commit(sc.hid, sc.siteId)), 'target-dirty')
})

test('a commit after the TTL is 410 expired (criterion 30b)', async () => {
  const timers = manualTimers()
  const sc = await targetScenario({ timers })
  await work(sc)
  await sent(sc)
  await timers.advance(16 * 60_000)
  await sc.queue.run(sc.siteId, async () => undefined)
  const answer = await sc.t.commit(sc.hid, sc.siteId)
  assert.equal(answer.kind, 'expired')
})

test('A FOLDER WITH ONLY IGNORED FILES where the WIP adds a file: 409 target-ignored-collision with the path, nothing touched, prepared with reason and paths; the abort then deletes the imported refs (criterion 27c, v4.3)', async () => {
  const sc = await targetScenario({
    setup: async (w) => {
      await writeFile(join(w.target, '.git', 'info', 'exclude'), '*.log\n')
      await put(w.target, 'foo/a.log', 'the owner’s log\n')
    },
  })
  await put(sc.w.source, 'foo', 'a file on the source\n')
  await sent(sc)
  const before = await snapshot(sc)
  const answer = await sc.t.commit(sc.hid, sc.siteId)
  assert.deepEqual(answer.kind === 'conflict' ? answer.handoff : undefined, { warnings: [], reason: 'target-ignored-collision', paths: ['foo'], pathCount: 1 })
  assert.deepEqual(await snapshot(sc), before)
  assert.equal(await readFile(join(sc.w.target, 'foo', 'a.log'), 'utf8'), 'the owner’s log\n')
  const journal = await journalOf(sc)
  assert.deepEqual([journal?.phase, journal?.reason, journal?.paths], ['prepared', 'target-ignored-collision', ['foo']])
  assert.notEqual(await refsOf(sc), '', 'the bundle was imported before the check')
  assert.equal((await sc.t.abort(sc.hid, sc.siteId)).kind, 'ok')
  assert.equal(await refsOf(sc), '')
  assert.equal((await journalOf(sc))?.phase, 'aborted')
})

test('more than HANDOFF_PATHS_MAX collisions: 50 paths travel, and pathCount says how many', async () => {
  const sc = await targetScenario({
    setup: async (w) => {
      await writeFile(join(w.target, '.git', 'info', 'exclude'), '*.local\n')
      for (let i = 0; i < 60; i += 1) await put(w.target, `f${String(i).padStart(2, '0')}.local`, 'owner\n')
    },
  })
  for (let i = 0; i < 60; i += 1) await put(sc.w.source, `f${String(i).padStart(2, '0')}.local`, 'source\n')
  await sent(sc)
  const answer = await sc.t.commit(sc.hid, sc.siteId)
  assert.equal(answer.kind === 'conflict' ? answer.handoff.paths?.length : 0, 50)
  assert.equal(answer.kind === 'conflict' ? answer.handoff.pathCount : 0, 60)
  assert.doesNotMatch(sc.target.lines.join('\n'), /f\d\d\.local/, 'how many, never which (criterion 36)')
})

test('a branch the target lacks: checkout -b at head, with its upstream when the remote has it', async () => {
  const sc = await targetScenario({
    setup: async (w) => {
      await sh(w.env, w.source, 'checkout', '--quiet', '-b', 'feature')
      await put(w.source, 'feature.md', 'f\n')
      await commitAll(w.env, w.source, 'feature')
      await sh(w.env, w.source, 'push', '--quiet', '-u', 'origin', 'feature')
    },
  })
  await sh(sc.w.env, sc.w.target, 'fetch', '--quiet', 'origin')
  await put(sc.w.source, 'wip.md', 'w\n')
  await sent(sc, { branch: 'feature' })
  assert.equal((await sc.t.commit(sc.hid, sc.siteId)).kind, 'ok')
  assert.equal(await sh(sc.w.env, sc.w.target, 'symbolic-ref', '--short', 'HEAD'), 'feature')
  assert.equal(await sh(sc.w.env, sc.w.target, 'rev-parse', '--abbrev-ref', 'feature@{u}'), 'origin/feature')
  assert.equal((await journalOf(sc))?.branchCreated, true)
})

test('THE INTENTION BEFORE THE STEP: a checkout -b that fails right after branchCreated is written leaves the journal saying so, and nothing more', async () => {
  const sc = await targetScenario({ setup: async (w) => void (await sh(w.env, w.source, 'checkout', '--quiet', '-b', 'feature')) })
  await put(sc.w.source, 'wip.md', 'w\n')
  await sent(sc, { branch: 'feature' })
  const before = await snapshot(sc)
  // A ref lock nobody releases: `checkout -b feature` cannot create the branch.
  await mkdir(join(sc.w.target, '.git', 'refs', 'heads'), { recursive: true })
  await writeFile(join(sc.w.target, '.git', 'refs', 'heads', 'feature.lock'), '')
  const answer = await sc.t.commit(sc.hid, sc.siteId)
  assert.equal(answer.kind, 'conflict')
  const journal = await journalOf(sc)
  assert.deepEqual([journal?.phase, journal?.branchCreated, journal?.installed, journal?.replaced], ['aborted', true, [], []])
  assert.deepEqual(await snapshot(sc), before)
  assert.deepEqual(await holders(sc), [])
})

// ---------------------------------------------------------------------------
// J6b — the install, by session
// ---------------------------------------------------------------------------

test('uploads: a new one is installed; the same id with the same bytes is skipped; the same id with OTHER bytes keeps the one here, and says upload-collision (criterion 28b)', async () => {
  const sc = await targetScenario({ sessions: 0 })
  const ids = { fresh: uuidv7(Date.now()), same: uuidv7(Date.now() + 1), other: uuidv7(Date.now() + 2) }
  const upload = async (root: string, id: string, content: string) => {
    await mkdir(join(root, id), { recursive: true })
    await writeFile(join(root, id, 'f.txt'), content)
  }
  await upload(sc.source.host.uploadsRoot, ids.fresh, 'fresh')
  await upload(sc.source.host.uploadsRoot, ids.same, 'same')
  await upload(sc.source.host.uploadsRoot, ids.other, 'from the source')
  await upload(sc.target.host.uploadsRoot, ids.same, 'same')
  await upload(sc.target.host.uploadsRoot, ids.other, 'the target’s own')
  const text = Object.values(ids).map((id) => `@${join(sc.source.host.uploadsRoot, id, 'f.txt')}`).join('\n')
  sc.sessions.push(await addSession(sc.source, { siteId: 'vault', events: [{ kind: 'message', role: 'user', text }], transcript: 't\n' }))
  await sent(sc)
  const answer = await sc.t.commit(sc.hid, sc.siteId)
  assert.deepEqual(answer.kind === 'ok' ? (answer.body as { handoff: unknown }).handoff : answer, { warnings: ['upload-collision'] })
  assert.equal(await readFile(join(sc.target.host.uploadsRoot, ids.fresh, 'f.txt'), 'utf8'), 'fresh')
  assert.equal(await readFile(join(sc.target.host.uploadsRoot, ids.other, 'f.txt'), 'utf8'), 'the target’s own')
  const journal = await journalOf(sc)
  assert.deepEqual(journal?.installed.filter((e) => e.kind === 'upload').map((e) => e.id), [ids.fresh])
  assert.doesNotMatch(sc.target.lines.join('\n'), /f\.txt/)
})

test('THE WAY BACK: the copy of the session and of its transcript this host had go to replaced/, the new ones are installed, and done empties replaced/ (criterion 28)', async () => {
  const sc = await targetScenario()
  const [session] = sc.sessions
  // What this host had: the session as it left, and its transcript in another folder.
  await sc.target.host.store.create({ id: session!.id, siteId: 'obsidian', entryId: 'free', startedAt: session!.startedAt, sitePath: sc.w.target, agent: undefined, prompt: 'p' })
  const oldFolder = join(sc.target.host.claudeProjects, '-elsewhere')
  await mkdir(oldFolder, { recursive: true })
  await writeFile(join(oldFolder, `${session!.id}.jsonl`), 'the old transcript\n')
  await sent(sc)
  assert.equal((await sc.t.commit(sc.hid, sc.siteId)).kind, 'ok')
  const journal = await journalOf(sc)
  assert.deepEqual(journal?.replaced, [
    { kind: 'transcript', id: session!.id, path: oldFolder },
    { kind: 'session', id: session!.id },
  ])
  const replaced = join(sc.target.host.paths.handoffWork(sc.hid, sc.siteId), 'replaced')
  assert.equal(await readFile(join(replaced, 'cli', '-elsewhere', `${session!.id}.jsonl`), 'utf8'), 'the old transcript\n')
  assert.equal(await there(join(oldFolder, `${session!.id}.jsonl`)), false)
  assert.equal((await sc.t.done(sc.hid, sc.siteId)).kind, 'ok')
  assert.equal(await there(replaced), false)
  assert.equal(await refsOf(sc), '')
  assert.equal((await journalOf(sc))?.phase, 'done')
})

// ---------------------------------------------------------------------------
// J7a — abort, and the undo
// ---------------------------------------------------------------------------

test('abort by phase: idempotent in aborted, 409 committed after a commit, and in prepared the staging and the refs go', async () => {
  const sc = await targetScenario()
  await work(sc)
  await sent(sc)
  const staging = join(sc.target.host.paths.handoffWork(sc.hid, sc.siteId), 'staging')
  assert.equal(await there(staging), true)
  assert.deepEqual(await sc.t.abort(sc.hid, sc.siteId), { kind: 'ok', body: { phase: 'aborted', handoff: { warnings: [] } } })
  assert.equal(await there(staging), false)
  assert.deepEqual(await holders(sc), [])
  assert.equal((await sc.t.abort(sc.hid, sc.siteId)).kind, 'ok', 'idempotent')

  const committed = await targetScenario()
  await sent(committed)
  await committed.t.commit(committed.hid, committed.siteId)
  assert.equal(reasonOf(await committed.t.abort(committed.hid, committed.siteId)), 'committed')
})

/** The target's handoff with its store wrapped: `importSession` and `restoreSession` can be made to fail. */
function wrapped(sc: TargetScenario, wrap: Partial<Pick<SessionStore, 'importSession' | 'restoreSession'>>): TargetScenario {
  const store = sc.target.host.store
  const proxy = new Proxy(store, { get: (target, key) => (key in wrap ? wrap[key as keyof typeof wrap] : (Reflect.get(target, key) as unknown as (...a: unknown[]) => unknown).bind?.(target) ?? Reflect.get(target, key)) })
  const host = { ...sc.target.host, store: proxy }
  const queue = new KeyedQueue()
  return { ...sc, target: { ...sc.target, host }, queue, t: createTarget({ host, queue }) }
}

test('a failure inside installing undoes everything — sessions, transcripts, the tree, the branch, the refs — and says why (criterion 30)', async () => {
  const base = await targetScenario({ sessions: 2 })
  await work(base)
  let imports = 0
  const sc = wrapped(base, {
    importSession: async (...args: Parameters<SessionStore['importSession']>) => {
      imports += 1
      if (imports === 2) throw new Error('disk full')
      return await base.target.host.store.importSession(...args)
    },
  })
  const before = await snapshot(sc)
  await sent(sc)
  const answer = await sc.t.commit(sc.hid, sc.siteId)
  assert.equal(reasonOf(answer), 'install-failed')
  assert.deepEqual(await snapshot(sc), before)
  assert.equal(await refsOf(sc), '')
  assert.equal((await journalOf(sc))?.phase, 'aborted')
  assert.deepEqual(await holders(sc), [])
})

test('A RESTORE THAT FAILS: abort-failed with its leftovers, the lock let go, the owner’s copy still in replaced/; a later abort answers 409 and touches nothing (criterion 32d)', async () => {
  const base = await targetScenario({ sessions: 2 })
  const [first] = base.sessions
  // The way back for the first: this host had it.
  await base.target.host.store.create({ id: first!.id, siteId: 'obsidian', entryId: 'free', startedAt: first!.startedAt, sitePath: base.w.target, agent: undefined, prompt: 'p' })
  let imports = 0
  const sc = wrapped(base, {
    importSession: async (...args: Parameters<SessionStore['importSession']>) => {
      imports += 1
      if (imports === 2) throw new Error('disk full')
      return await base.target.host.store.importSession(...args)
    },
    restoreSession: async () => {
      throw new Error('EACCES')
    },
  })
  await sent(sc)
  const answer = await sc.t.commit(sc.hid, sc.siteId)
  assert.equal(reasonOf(answer), 'abort-failed')
  const journal = await journalOf(sc)
  assert.equal(journal?.phase, 'abort-failed')
  assert.deepEqual(journal?.leftovers, [{ step: 'restoreSession', kind: 'session', id: first!.id }])
  assert.deepEqual(await holders(sc), [])
  const replaced = join(sc.target.host.paths.handoffWork(sc.hid, sc.siteId), 'replaced', first!.id)
  assert.equal(await there(replaced), true, 'the owner’s only copy is still there')
  const again = await sc.t.abort(sc.hid, sc.siteId)
  assert.equal(reasonOf(again), 'abort-failed')
  assert.equal(await there(replaced), true)
  assert.match(sc.target.lines.join('\n'), /run factotum doctor/)
})

test('a change made on the target mid-commit is rescued before the reset: target-rescued in the journal and in the 409’s handoff (criterion 30c)', async () => {
  const base = await targetScenario()
  await work(base)
  const sc = wrapped(base, {
    importSession: async () => {
      // Obsidian writes into the tree while the commit runs; then the install fails.
      await writeFile(join(base.w.target, 'a.txt'), 'typed mid-handoff\n')
      throw new Error('disk full')
    },
  })
  await sent(sc)
  const answer = await sc.t.commit(sc.hid, sc.siteId)
  assert.deepEqual(answer.kind === 'conflict' ? answer.handoff.warnings : undefined, ['target-rescued'])
  assert.equal(await sh(sc.w.env, sc.w.target, 'show', `refs/factotum/handoff-rescue/${sc.hid}:a.txt`), 'typed mid-handoff')
  assert.equal((await journalOf(sc))?.phase, 'aborted')
})

// ---------------------------------------------------------------------------
// J7b — done
// ---------------------------------------------------------------------------

test('done empties replaced/ and staging/, deletes the refs, and says done; before a commit it is refused', async () => {
  const sc = await targetScenario()
  await work(sc)
  await sent(sc)
  assert.equal(reasonOf(await sc.t.done(sc.hid, sc.siteId)), 'wrong-phase')
  await sc.t.commit(sc.hid, sc.siteId)
  assert.notEqual(await refsOf(sc), '')
  assert.deepEqual(await sc.t.done(sc.hid, sc.siteId), { kind: 'ok', body: { phase: 'done' } })
  assert.equal(await refsOf(sc), '')
  assert.equal(await there(join(sc.target.host.paths.handoffWork(sc.hid, sc.siteId), 'staging')), false)
  assert.deepEqual(await sc.t.done(sc.hid, sc.siteId), { kind: 'ok', body: { phase: 'done' } })
})

test('an abort that finds installing (after a restart that left it): the undo runs, and the answer says aborted', async () => {
  const sc = await targetScenario()
  await work(sc)
  await sent(sc)
  const journal = await journalOf(sc)
  const { writeJournal } = await import('./journal.ts')
  await writeJournal(sc.target.host.paths, { ...journal!, phase: 'installing' })
  const answer = await sc.t.abort(sc.hid, sc.siteId)
  assert.equal(answer.kind === 'ok' ? (answer.body as { phase: string }).phase : answer.kind, 'aborted')
  assert.deepEqual(await holders(sc), [])
})
