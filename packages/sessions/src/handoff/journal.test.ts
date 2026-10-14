import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionPaths } from '../paths.ts'
import { uuidv7 } from '../id.ts'
import {
  isHandoffId,
  listHids,
  listJournals,
  newJournal,
  readJournal,
  readRun,
  writeJournal,
  writeRun,
  type Journal,
} from './journal.ts'

async function paths() {
  return sessionPaths(await mkdtemp(join(tmpdir(), 'factotum-journal-')))
}

const HID = uuidv7(Date.parse('2026-10-14T00:00:00Z'))

test('a journal is written and read back whole, with every field of design D11', async () => {
  const p = await paths()
  const journal: Journal = {
    ...newJournal({ hid: HID, siteId: 'vault', role: 'target', peer: 'mac', phase: 'installing', at: '2026-10-14T00:00:00.000Z' }),
    branch: 'main',
    head: 'a'.repeat(40),
    wip: 'b'.repeat(40),
    tree: 'c'.repeat(40),
    prevBranch: 'main',
    prevHead: 'd'.repeat(40),
    branchHead: 'd'.repeat(40),
    branchCreated: false,
    sessionIds: [uuidv7(1)],
    lastSignalAt: '2026-10-14T00:01:00.000Z',
    installed: [{ kind: 'upload', id: uuidv7(2) }, { kind: 'transcript', id: uuidv7(1), path: '/home/x/.claude/projects/-a' }],
    replaced: [{ kind: 'session', id: uuidv7(1) }],
    leftovers: [{ step: 'restoreSession', kind: 'session', id: uuidv7(1) }],
    stoppedServices: ['s1'],
    warnings: ['upload-collision'],
    reason: 'target-ignored-collision',
    paths: ['secret.local'],
    pathCount: 1,
    peerSiteId: 'personal',
    targetReason: 'target-dirty',
    targetWarnings: ['target-rescued'],
    targetPaths: ['x'],
    targetPathCount: 1,
  }
  await writeJournal(p, journal)
  assert.deepEqual(await readJournal(p, HID, 'vault'), journal)
})

test('a fresh journal has the empty lists D11 says are always there', () => {
  const journal = newJournal({ hid: HID, siteId: 'vault', role: 'source', peer: 'omarchy', phase: 'locking', at: 'now' })
  assert.deepEqual(
    { installed: journal.installed, replaced: journal.replaced, stoppedServices: journal.stoppedServices, warnings: journal.warnings, targetWarnings: journal.targetWarnings },
    { installed: [], replaced: [], stoppedServices: [], warnings: [], targetWarnings: [] },
  )
})

test('a concurrent reader never sees a journal half written: the write is atomic (tmp + rename)', async () => {
  const p = await paths()
  const big = (n: number): Journal => ({
    ...newJournal({ hid: HID, siteId: 'vault', role: 'target', peer: 'mac', phase: 'installing', at: String(n) }),
    installed: Array.from({ length: 400 }, (_, i) => ({ kind: 'upload' as const, id: uuidv7(i), path: `/some/long/path/${n}/${i}` })),
  })
  await writeJournal(p, big(0))
  let stop = false
  let reads = 0
  const reader = (async () => {
    while (!stop) {
      const read = await readJournal(p, HID, 'vault')
      assert.notEqual(read, undefined, 'never a torn file')
      assert.equal(read?.installed.length, 400)
      reads += 1
    }
  })()
  for (let n = 1; n <= 60; n += 1) await writeJournal(p, big(n))
  stop = true
  await reader
  assert.ok(reads > 0)
})

test('a hid that is not a handoff id never becomes a path: read gives undefined, write throws, nothing is created', async () => {
  const p = await paths()
  for (const hid of ['../../etc', 'x', '', '0199e0c0-0000-7000-8000-00000000000g']) {
    assert.equal(isHandoffId(hid), false, hid)
    assert.equal(await readJournal(p, hid, 'vault'), undefined)
    await assert.rejects(writeJournal(p, newJournal({ hid, siteId: 'vault', role: 'source', peer: 'x', phase: 'locking', at: 'now' })))
  }
  assert.equal(await readdir(p.handoff).catch(() => 'absent'), 'absent')
})

test('a siteId that is not one never becomes a path either', async () => {
  const p = await paths()
  for (const siteId of ['../x', 'A B', '', 'x/y']) {
    assert.equal(await readJournal(p, HID, siteId), undefined)
    await assert.rejects(writeJournal(p, newJournal({ hid: HID, siteId, role: 'source', peer: 'x', phase: 'locking', at: 'now' })))
  }
})

test('a journal on disk that is not one reads as undefined, never a throw', async () => {
  const p = await paths()
  await mkdir(p.handoffDir(HID), { recursive: true })
  await writeFile(p.journalFile(HID, 'vault'), '{ "hid": "not this one" ')
  assert.equal(await readJournal(p, HID, 'vault'), undefined)
  await writeFile(p.journalFile(HID, 'vault'), JSON.stringify({ hid: HID, siteId: 'other', role: 'source' }))
  assert.equal(await readJournal(p, HID, 'vault'), undefined, 'the file names the project, not its contents')
})

test('the journals of one handoff, and the handoffs on disk, are listed by their names', async () => {
  const p = await paths()
  const other = uuidv7(Date.parse('2026-10-15T00:00:00Z'))
  for (const siteId of ['vault', 'matilde']) await writeJournal(p, newJournal({ hid: HID, siteId, role: 'source', peer: 'omarchy', phase: 'locked', at: 'now' }))
  await writeJournal(p, newJournal({ hid: other, siteId: 'vault', role: 'target', peer: 'mac', phase: 'prepared', at: 'now' }))
  await mkdir(join(p.handoff, 'not-a-hid'), { recursive: true })
  assert.deepEqual((await listJournals(p, HID)).map((j) => j.siteId).sort(), ['matilde', 'vault'])
  assert.deepEqual([...(await listHids(p))].sort(), [HID, other].sort())
})

test('run.json is written once and read back', async () => {
  const p = await paths()
  await writeRun(p, { hid: HID, peer: 'omarchy', startedAt: '2026-10-14T00:00:00.000Z', siteIds: ['vault'] })
  assert.deepEqual(await readRun(p, HID), { hid: HID, peer: 'omarchy', startedAt: '2026-10-14T00:00:00.000Z', siteIds: ['vault'] })
  assert.equal(await readRun(p, uuidv7(1)), undefined)
})
