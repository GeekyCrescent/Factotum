import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { acceptSubmit, linkSession, startRun } from './ops.ts'
import { staleRuns, sweep } from './runs.ts'
import { STARTING_ABANDON_MS } from './shape.ts'
import { openStore } from './store/store.ts'
import { captureLog, mockup, NOW, SESSION } from './test-support.ts'
import type { Mockup, MockupsFile, Result } from './types.ts'

const at = (ms: number) => new Date(NOW.getTime() + ms)
const value = (r: Result<Mockup>): Mockup => {
  if (!r.ok) throw new Error(r.error.reason)
  return r.value
}
const started = (id: string) => value(startRun(mockup({ id }), { kind: 'brief', runId: `r-${id}`, siteId: 'personal' }, NOW))

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mockups-runs-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('crit. 18: a run without a session is stale only after STARTING_ABANDON_MS', () => {
  const file: MockupsFile = { version: 1, mockups: [started('a')] }
  assert.deepEqual(staleRuns(file, at(STARTING_ABANDON_MS - 1)), [])
  assert.deepEqual(staleRuns(file, at(STARTING_ABANDON_MS)), [{ mockupId: 'a', runId: 'r-a' }])
})

test('a run with a session, or already stalled, is never swept', () => {
  const linked = value(linkSession(started('a'), 'r-a', SESSION, NOW))
  const file: MockupsFile = { version: 1, mockups: [linked] }
  assert.deepEqual(staleRuns(file, at(STARTING_ABANDON_MS * 2)), [])
})

test('crit. 18: the sweep marks it stalled — never abandons it — and a later submission is accepted', async () => {
  const opened = await openStore({ dir, now: NOW, log: captureLog() })
  assert.ok(opened.ok)
  await opened.store.change((file) => ({ ok: true, value: { file: { ...file, mockups: [started('a'), started('b')] } } }))
  const log = captureLog()
  const swept = await sweep(opened.store, at(STARTING_ABANDON_MS), log)
  assert.equal(swept, 2)
  const after = opened.store.current().mockups[0]
  assert.ok(after !== undefined)
  assert.equal(after.stages.brief.status, 'stalled')
  assert.equal(after.stages.brief.run?.id, 'r-a')
  assert.deepEqual(log.lines, [
    'info mockup a: brief run r-a had no session after 10 min; stalled',
    'info mockup b: brief run r-b had no session after 10 min; stalled',
  ])
  const accepted = value(acceptSubmit(after, 'r-a', { sessionId: SESSION, summary: 's' }, at(STARTING_ABANDON_MS + 1)))
  assert.equal(accepted.stages.brief.status, 'waiting')
  assert.equal(await sweep(opened.store, at(STARTING_ABANDON_MS * 3), log), 0)
})

test('review: a run linked between the snapshot and the change is not stalled', async () => {
  const opened = await openStore({ dir, now: NOW, log: captureLog() })
  assert.ok(opened.ok)
  await opened.store.change((file) => ({ ok: true, value: { file: { ...file, mockups: [started('a')] } } }))
  const linking = opened.store.change((file) => ({ ok: true, value: { file: { ...file, mockups: file.mockups.map((m) => value(linkSession(m, 'r-a', SESSION, NOW))) } } }))
  const swept = sweep(opened.store, at(STARTING_ABANDON_MS), captureLog())
  await linking
  assert.equal(await swept, 0)
  assert.equal(opened.store.current().mockups[0]?.stages.brief.status, 'running')
})
