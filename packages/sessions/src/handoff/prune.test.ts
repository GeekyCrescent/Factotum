import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sh, world, type World } from '../test-repos.ts'
import { fakePeer, makeHost, type TestHost } from '../test-handoff.ts'
import { uuidv7 } from '../id.ts'
import { KeyedQueue } from '../keyed-queue.ts'
import { newJournal, readJournal, writeJournal, writeRun, type Journal } from './journal.ts'
import { hidTime, prune } from './prune.ts'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-01T00:00:00Z')
const there = async (path: string) => (await lstat(path).catch(() => undefined)) !== undefined

async function setup(): Promise<{ w: World; h: TestHost }> {
  const w = await world()
  const h = await makeHost({ name: 'mac', projects: [{ id: 'vault', path: w.source }], env: w.env, peers: fakePeer('omarchy', { route: undefined, reachable: false }), now: () => new Date(NOW) })
  return { w, h }
}

/** A handoff `days` old, its journal in `phase`, and its work folder with everything in it. */
async function handoff(h: TestHost, days: number, phase: Journal['phase'], role: Journal['role'] = 'target', replaced = false): Promise<{ hid: string; work: string }> {
  const hid = uuidv7(NOW - days * DAY)
  await writeJournal(h.host.paths, newJournal({ hid, siteId: 'vault', role, peer: 'omarchy', phase, at: 'x' }))
  await writeRun(h.host.paths, { hid, peer: 'omarchy', startedAt: 'x', siteIds: ['vault'] })
  const work = h.host.paths.handoffWork(hid, 'vault')
  await mkdir(join(work, 'staging'), { recursive: true })
  await mkdir(join(work, 'replaced'), { recursive: true })
  if (replaced) await writeFile(join(work, 'replaced', 'owner-copy'), 'the only copy')
  await writeFile(join(work, 'code.bundle'), 'b')
  await writeFile(join(work, 'index'), 'i')
  return { hid, work }
}

const run = (h: TestHost) => prune(h.host, new KeyedQueue())

test('the age of a handoff is its hid’s', () => {
  assert.equal(hidTime(uuidv7(NOW - 3 * DAY)), NOW - 3 * DAY)
})

test('a LIVE handoff is never touched, whatever its age', async () => {
  const { h } = await setup()
  for (const phase of ['preparing', 'prepared', 'installing'] as const) {
    const { hid, work } = await handoff(h, 30, phase)
    await run(h)
    assert.equal((await readJournal(h.host.paths, hid, 'vault'))?.phase, phase)
    assert.equal(await there(join(work, 'staging')), true)
  }
})

test('nothing of an abort-failed, not even after HANDOFF_BACKUP_DAYS (criterion 32d)', async () => {
  const { h } = await setup()
  const { hid, work } = await handoff(h, 30, 'abort-failed', 'target', true)
  await run(h)
  assert.equal((await readJournal(h.host.paths, hid, 'vault'))?.phase, 'abort-failed')
  assert.equal(await there(join(work, 'replaced', 'owner-copy')), true)
  assert.equal(await there(join(work, 'staging')), true)
})

test('done: replaced/ goes at once, the staging and the bundle too; the journal after 24 h, and then the folder and run.json', async () => {
  const { h } = await setup()
  const young = await handoff(h, 0.5, 'done', 'target', true)
  await run(h)
  assert.equal(await there(join(young.work, 'replaced')), false)
  assert.equal(await there(join(young.work, 'staging')), false)
  assert.equal(await there(join(young.work, 'code.bundle')), false)
  assert.notEqual(await readJournal(h.host.paths, young.hid, 'vault'), undefined, 'the journal stays a day, for status')
  const old = await handoff(h, 2, 'done')
  await run(h)
  assert.equal(await readJournal(h.host.paths, old.hid, 'vault'), undefined)
  assert.equal(await there(h.host.paths.handoffDir(old.hid)), false, 'run.json and the folder, once no journal is left')
})

test('aborted with an EMPTY replaced/: gone; with something in it: kept, journal and all, until HANDOFF_BACKUP_DAYS (v4.2)', async () => {
  const { h } = await setup()
  const empty = await handoff(h, 2, 'aborted')
  const full = await handoff(h, 2, 'aborted', 'target', true)
  await run(h)
  assert.equal(await readJournal(h.host.paths, empty.hid, 'vault'), undefined)
  assert.equal(await there(join(full.work, 'replaced', 'owner-copy')), true)
  assert.notEqual(await readJournal(h.host.paths, full.hid, 'vault'), undefined)
  const late = await handoff(h, 15, 'aborted', 'target', true)
  await run(h)
  assert.equal(await there(join(late.work, 'replaced')), false)
  assert.match(h.lines.join('\n'), /replaced\/ after 14 days/)
})

test('committed without done: replaced/ and the journal wait HANDOFF_BACKUP_DAYS', async () => {
  const { h } = await setup()
  const young = await handoff(h, 3, 'committed', 'target', true)
  const old = await handoff(h, 15, 'committed', 'target', true)
  await run(h)
  assert.equal(await there(join(young.work, 'replaced', 'owner-copy')), true)
  assert.notEqual(await readJournal(h.host.paths, young.hid, 'vault'), undefined)
  assert.equal(await readJournal(h.host.paths, old.hid, 'vault'), undefined)
})

test('kept, on the source: the journal after 24 h', async () => {
  const { h } = await setup()
  const kept = await handoff(h, 2, 'kept', 'source')
  await run(h)
  assert.equal(await readJournal(h.host.paths, kept.hid, 'vault'), undefined)
})

test('the refs: backups and rescues after 14 days; handoff/<hid>/* once no live journal is left — never an abort-failed’s', async () => {
  const { w, h } = await setup()
  const head = await sh(w.env, w.source, 'rev-parse', 'HEAD')
  const hids = {
    oldBackup: uuidv7(NOW - 15 * DAY),
    youngRescue: uuidv7(NOW - 3 * DAY),
    orphan: uuidv7(NOW - 1 * DAY),
    live: (await handoff(h, 1, 'prepared')).hid,
    failed: (await handoff(h, 30, 'abort-failed')).hid,
  }
  // Aged by its COMMIT's date, this host's clock: a backup made fifteen days ago.
  const old = await sh({ ...w.env, GIT_COMMITTER_DATE: new Date(NOW - 15 * DAY).toISOString() }, w.source, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'wip')
  await sh(w.env, w.source, 'update-ref', `refs/factotum/handoff-backup/${hids.oldBackup}`, old)
  const young = await sh({ ...w.env, GIT_COMMITTER_DATE: new Date(NOW - 3 * DAY).toISOString() }, w.source, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'rescue')
  await sh(w.env, w.source, 'update-ref', `refs/factotum/handoff-rescue/${hids.youngRescue}`, young)
  for (const hid of [hids.orphan, hids.live, hids.failed]) await sh(w.env, w.source, 'update-ref', `refs/factotum/handoff/${hid}/head`, head)
  await run(h)
  const left = (await sh(w.env, w.source, 'for-each-ref', '--format=%(refname)', 'refs/factotum/')).split('\n').sort()
  assert.deepEqual(left, [`refs/factotum/handoff-rescue/${hids.youngRescue}`, `refs/factotum/handoff/${hids.failed}/head`, `refs/factotum/handoff/${hids.live}/head`].sort())
})

test('a project that is no longer a repo is skipped, and said without its path', async () => {
  const { w, h } = await setup()
  const notARepo = join(w.home, 'plain')
  await mkdir(notARepo)
  h.projects.push({ id: 'plain', path: notARepo })
  await run(h)
  assert.match(h.lines.join('\n'), /project plain is not a repo; skipped/)
  assert.doesNotMatch(h.lines.join('\n'), new RegExp(notARepo))
  assert.deepEqual(await readdir(notARepo), [])
})
