import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commitAll, indexPath, put, sh, world } from '../test-repos.ts'
import { addSession, linked, type Linked } from '../test-handoff.ts'
import { uuidv7 } from '../id.ts'
import { cliDirOf } from './cli-paths.ts'
import { wipTree } from './wip.ts'

/** A second project on both hosts: another bare remote, cloned on each side. */
async function secondProject(l: Linked, macId: string, omarchyId: string) {
  const other = await world()
  l.mac.projects.push({ id: macId, path: other.source })
  l.omarchy.projects.push({ id: omarchyId, path: other.target })
  return other
}

async function report(l: Linked, side: 'mac' | 'omarchy', hid: string) {
  const answer = await l[side].api.report(hid)
  assert.equal(answer.kind, 'ok')
  return answer.kind === 'ok' ? (answer.body as { state: string; projects: { siteId: string; phase: string; reason?: string; targetReason?: string; stoppedServices: string[] }[]; skipped: { siteId: string; sessionId?: string; reason: string }[] }) : undefined
}

async function handoff(l: Linked, from: 'mac' | 'omarchy', to: string) {
  const started = await l[from].api.start({ to })
  assert.equal(started.kind === 'ok' ? started.status : started.kind, 202)
  const hid = started.kind === 'ok' ? (started.body as { hid: string }).hid : ''
  await l[from].api.settled()
  return { hid, report: await report(l, from, hid) }
}

test('«ME VOY» END TO END: three sessions at rest go with their whole history, the commit and the change with them; the one working stays, and so does its project; the remote never moves (criteria 24-29, 27b)', async () => {
  const l = await linked()
  const matilde = await secondProject(l, 'matilde', 'matilde-bwr')
  // The vault: a local commit nobody pushed, a change, an untracked note, and three sessions at rest.
  await put(l.w.source, 'local.md', 'local commit\n')
  await commitAll(l.w.env, l.w.source, 'local')
  await put(l.w.source, 'a.txt', 'uncommitted change\n')
  await put(l.w.source, 'notes/new.md', 'untracked\n')
  const resting = [
    await addSession(l.mac, { siteId: 'vault', transcript: '{"t":1}\n', events: [{ kind: 'message', role: 'user', text: 'remember CARPINCHO-77' }, { kind: 'message', role: 'assistant', text: 'ok' }] }),
    await addSession(l.mac, { siteId: 'vault', transcript: '{"t":2}\n' }),
    await addSession(l.mac, { siteId: 'vault', transcript: '{"t":3}\n' }),
  ]
  // Matilde: one working, one at rest.
  const working = await addSession(l.mac, { siteId: 'matilde', transcript: 'x\n', meta: { state: 'running' } })
  await l.mac.host.locks.acquire('matilde', working.id, new Date().toISOString())
  const idle = await addSession(l.mac, { siteId: 'matilde', transcript: 'y\n' })
  const remoteBefore = await sh(l.w.env, l.w.source, 'ls-remote', 'origin')
  const head = await sh(l.w.env, l.w.source, 'rev-parse', 'HEAD')
  const tree = await wipTree(l.w.source, { indexFile: await indexPath(l.w), base: l.w.env })
  const logsBefore = await Promise.all(resting.map((s) => readFile(l.mac.host.paths.eventsFile(s.id), 'utf8')))

  const { hid, report: moved } = await handoff(l, 'mac', 'omarchy')

  assert.equal(moved?.state, 'finished')
  assert.deepEqual(moved?.projects.map((p) => [p.siteId, p.phase]), [['vault', 'done']])
  assert.deepEqual(
    [...(moved?.skipped ?? [])].sort((a, b) => a.reason.localeCompare(b.reason)),
    [
      { siteId: 'matilde', sessionId: idle.id, reason: 'project-busy' },
      { siteId: 'matilde', sessionId: working.id, reason: 'running' },
    ],
  )
  // The conversations, on omarchy: the same events, plus ONE handoff event, with omarchy's meta.
  for (const [i, session] of resting.entries()) {
    const there = await readFile(l.omarchy.host.paths.eventsFile(session.id), 'utf8')
    assert.ok(there.startsWith(logsBefore[i] ?? '\u0000'), 'the whole history, first')
    const events = (await l.omarchy.host.store.read(session.id, 0)).events
    assert.deepEqual(events.filter((e) => e.kind === 'handoff').map((e) => (e.kind === 'handoff' ? [e.from, e.to, e.hid] : [])), [['juans-macbook-pro', 'omarchy', hid]])
    const meta = await l.omarchy.host.store.readMeta(session.id)
    assert.deepEqual([meta?.siteId, meta?.sitePath, meta?.movedTo], ['obsidian', l.w.target, undefined])
    assert.equal(await readFile(join(l.omarchy.host.claudeProjects, await cliDirOf(l.w.target), `${session.id}.jsonl`), 'utf8').then(() => true), true)
    // On the Mac: «Moved to omarchy», read-only.
    assert.equal((await l.mac.host.store.readMeta(session.id))?.movedTo, 'omarchy')
  }
  // The code (criterion 26): the same commit on the same branch, and the same working tree.
  assert.equal(await sh(l.w.env, l.w.target, 'rev-parse', 'HEAD'), head)
  assert.equal(await sh(l.w.env, l.w.target, 'symbolic-ref', '--short', 'HEAD'), 'main')
  assert.equal(await wipTree(l.w.target, { indexFile: await indexPath(l.w), base: l.w.env }), tree)
  assert.equal(await readFile(join(l.w.target, 'notes', 'new.md'), 'utf8'), 'untracked\n')
  // The source is clean, with the WIP backed up; nothing went to the remote (criterion 27b).
  assert.equal(await sh(l.w.env, l.w.source, 'status', '--porcelain'), '')
  assert.notEqual(await sh(l.w.env, l.w.source, 'rev-parse', `refs/factotum/handoff-backup/${hid}`), '')
  assert.equal(await sh(l.w.env, l.w.source, 'ls-remote', 'origin'), remoteBefore)
  // Matilde did not move at all.
  assert.equal((await l.mac.host.store.readMeta(idle.id))?.movedTo, undefined)
  assert.equal(await sh(l.w.env, matilde.source, 'rev-parse', 'HEAD'), await sh(l.w.env, matilde.source, 'rev-parse', 'origin/main'))
  // No lock left on either side for the vault.
  assert.deepEqual(await l.mac.host.locks.holders('vault'), [])
  assert.deepEqual(await l.omarchy.host.locks.holders('obsidian'), [])
  // The target's leftovers went with `done`.
  assert.equal(await sh(l.w.env, l.w.target, 'for-each-ref', 'refs/factotum/handoff/'), '')
})

test('«VOLVÍ»: Mac → omarchy → Mac keeps the history of the three legs, one handoff event per crossing, and the Mac takes the conversation again (criterion 28)', async () => {
  const l = await linked()
  await put(l.w.source, 'a.txt', 'changed on the Mac\n')
  const session = await addSession(l.mac, { siteId: 'vault', transcript: '{"leg":1}\n', events: [{ kind: 'message', role: 'user', text: 'leg one' }] })
  const first = await handoff(l, 'mac', 'omarchy')
  assert.deepEqual(first.report?.projects.map((p) => p.phase), ['done'])

  // On omarchy the conversation goes on, and the tree with it.
  await l.omarchy.host.store.append(session.id, { kind: 'message', role: 'user', text: 'leg two, on omarchy' })
  await put(l.w.target, 'b.txt', 'written on omarchy\n')
  const back = await handoff(l, 'omarchy', 'juans-macbook-pro')
  assert.deepEqual(back.report?.projects.map((p) => [p.siteId, p.phase]), [['obsidian', 'done']])

  const events = (await l.mac.host.store.read(session.id, 0)).events
  const texts = events.filter((e) => e.kind === 'message').map((e) => (e.kind === 'message' ? e.text : ''))
  assert.deepEqual(texts, ['leg one', 'leg two, on omarchy'])
  assert.deepEqual(events.filter((e) => e.kind === 'handoff').map((e) => (e.kind === 'handoff' ? `${e.from}→${e.to}` : '')), ['juans-macbook-pro→omarchy', 'omarchy→juans-macbook-pro'])
  const meta = await l.mac.host.store.readMeta(session.id)
  assert.deepEqual([meta?.siteId, meta?.sitePath, meta?.movedTo], ['vault', l.w.source, undefined], 'the Mac’s own, and not moved: it takes replies again')
  assert.equal((await l.omarchy.host.store.readMeta(session.id))?.movedTo, 'juans-macbook-pro')
  assert.equal(await readFile(join(l.w.source, 'b.txt'), 'utf8'), 'written on omarchy\n')
  assert.equal(await readFile(join(l.w.source, 'a.txt'), 'utf8'), 'changed on the Mac\n')
})

test('a second POST /handoff while one is alive is 409; an unknown hid is 404, one with another shape 400', async () => {
  const l = await linked()
  await addSession(l.mac, { siteId: 'vault', transcript: 'x\n' })
  let release = () => undefined as void
  l.toOmarchy.delay = () => new Promise<void>((resolve) => (release = resolve))
  const first = await l.mac.api.start({ to: 'omarchy' })
  assert.equal(first.kind, 'ok')
  const second = await l.mac.api.start({ to: 'omarchy' })
  assert.equal(second.kind === 'conflict' ? second.handoff.reason : second.kind, 'handoff-alive')
  l.toOmarchy.delay = undefined
  release()
  await l.mac.api.settled()
  assert.equal((await l.mac.api.report(uuidv7(1))).kind, 'not-found')
  assert.equal((await l.mac.api.report('../x')).kind, 'invalid')
  assert.equal((await l.mac.api.start({ to: 'nobody' })).kind, 'invalid')
})

test('a plan that cannot be made (the peer down) is a handoff that failed, with why, and nothing locked', async () => {
  const l = await linked()
  await addSession(l.mac, { siteId: 'vault', transcript: 'x\n' })
  l.toOmarchy.reachable = false
  const { report: failed } = await handoff(l, 'mac', 'omarchy')
  assert.deepEqual([failed?.state, (failed as { failure?: string } | undefined)?.failure, failed?.projects], ['failed', 'peer-unreachable', []])
  assert.deepEqual(await l.mac.host.locks.holders('vault'), [])
})
