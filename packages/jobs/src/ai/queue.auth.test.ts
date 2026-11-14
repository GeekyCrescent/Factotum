import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW, valueOf } from '../test-state.ts'
import { tempBase } from '../test-support.ts'
import { AUTH_PAUSE_MS, MAX_ATTEMPTS, type JobResult } from './queue.ts'
import { AUTH_REASON } from './run.ts'
import { DONE, queueStore, rig, workOf } from './test-queue.ts'

const AUTH: JobResult = { ok: false, kind: 'auth', reason: AUTH_REASON }
const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString()

/** A `cv` handler that answers `results` in order, then DONE; `calls()` counts the runs. */
function scripted(first: readonly JobResult[]) {
  let results = [...first]
  let calls = 0
  return {
    calls: () => calls,
    cv: async (): Promise<JobResult> => {
      calls += 1
      const [next = DONE, ...rest] = results
      results = rest
      return next
    },
  }
}

test('a logged-out CLI pauses the whole queue for the fixed interval and adds no attempt', async () => {
  // Arrange
  using base = tempBase()
  const db = await queueStore(base)
  const script = scripted([AUTH, AUTH])
  const { queue } = rig(db, { concurrency: 3, handlers: { cv: script.cv } })

  // Act
  const ids = ['a1', 'a2', 'a3'].map((ref) => valueOf(queue.add({ kind: 'cv', ref })).id)
  await queue.settled()

  // Assert
  assert.equal(script.calls(), 2, 'the two bulk slots ran; the third waits')
  assert.equal(queue.pausedUntil(), at(AUTH_PAUSE_MS))
  assert.deepEqual(
    ids.map((id) => [workOf(db, id).state, workOf(db, id).attempts]),
    [
      ['queued', 0],
      ['queued', 0],
      ['queued', 0],
    ],
  )
  assert.equal(workOf(db, ids[0]!).reason, AUTH_REASON)
})

test('after the interval ONE probe runs; when it is logged out again the queue stays paused; when it answers, everything runs', async () => {
  // Arrange
  using base = tempBase()
  const db = await queueStore(base)
  const script = scripted([AUTH, AUTH, AUTH])
  const { queue, clock } = rig(db, { concurrency: 3, handlers: { cv: script.cv } })
  const ids = ['a1', 'a2', 'a3'].map((ref) => valueOf(queue.add({ kind: 'cv', ref })).id)
  await queue.settled()

  // Act: just before the interval, nothing leaves
  clock.advance(AUTH_PAUSE_MS - 1)
  queue.pump()
  assert.deepEqual(queue.running(), [], 'nothing leaves while paused')

  // Act: at the interval, one probe — logged out again
  clock.advance(1)
  queue.pump()
  assert.equal(queue.running().length, 1, 'one probe')
  await queue.settled()
  assert.equal(script.calls(), 3)
  assert.equal(queue.pausedUntil(), at(2 * AUTH_PAUSE_MS), 'paused again, from the probe')

  // Act: the next probe answers
  clock.advance(AUTH_PAUSE_MS)
  queue.pump()
  assert.equal(queue.running().length, 1, 'one probe again')
  await queue.settled()

  // Assert
  assert.equal(queue.pausedUntil(), null)
  assert.equal(script.calls(), 6, 'after the probe, the other two')
  assert.deepEqual(
    ids.map((id) => [workOf(db, id).state, workOf(db, id).attempts]),
    [
      ['done', 0],
      ['done', 0],
      ['done', 0],
    ],
  )
})

test(`logged out more than ${MAX_ATTEMPTS} times in a row, a work never reaches its third attempt`, async () => {
  // Arrange
  using base = tempBase()
  const db = await queueStore(base)
  const script = scripted(Array.from({ length: MAX_ATTEMPTS * 3 }, () => AUTH))
  const { queue, clock } = rig(db, { handlers: { cv: script.cv } })
  const id = valueOf(queue.add({ kind: 'cv', ref: 'a1' })).id

  // Act
  for (let hit = 0; hit < MAX_ATTEMPTS * 3; hit += 1) {
    await queue.settled()
    clock.advance(AUTH_PAUSE_MS)
    queue.pump()
  }
  await queue.settled()

  // Assert
  assert.equal(script.calls(), MAX_ATTEMPTS * 3 + 1)
  assert.deepEqual([workOf(db, id).state, workOf(db, id).attempts], ['done', 0])
})
