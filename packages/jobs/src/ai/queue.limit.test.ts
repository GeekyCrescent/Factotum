import { test } from 'node:test'
import assert from 'node:assert/strict'
import { valueOf } from '../test-state.ts'
import { tempBase } from '../test-support.ts'
import { LIMIT_STREAK_MAX, type JobHandler, type JobResult } from './queue.ts'
import { DONE, queueStore, rig, workOf } from './test-queue.ts'

const MINUTE = 60_000
const LIMIT: JobHandler = async () => ({ ok: false, kind: 'limit', reason: 'claude hit its usage limit' })

test(`a limit hit ${LIMIT_STREAK_MAX} times in a row by the same work counts as an attempt, and says so in the log`, async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue, clock, log } = rig(db, { handlers: { cv: LIMIT } })
  const id = valueOf(queue.add({ kind: 'cv', ref: 'a1' })).id
  for (let hit = 1; hit < LIMIT_STREAK_MAX; hit += 1) {
    await queue.settled()
    assert.equal(workOf(db, id).attempts, 0, `a limit adds no attempt (hit ${hit})`)
    clock.advance(30 * MINUTE)
    queue.pump()
  }
  await queue.settled()
  const work = workOf(db, id)
  assert.deepEqual([work.state, work.attempts], ['queued', 1])
  assert.notEqual(queue.pausedUntil(), null, 'still a pause: it was a limit')
  assert.ok(log.lines.some((line) => line.startsWith('warn') && line.includes(id) && line.includes(`${LIMIT_STREAK_MAX} times in a row`)))
})

test('an answer that is not a limit ends the streak: the count starts again', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const limit: JobResult = { ok: false, kind: 'limit', reason: 'claude hit its usage limit' }
  const almost = Array.from({ length: LIMIT_STREAK_MAX - 1 }, () => limit)
  let results: JobResult[] = [...almost, { ok: false, kind: 'failed', reason: 'claude exited with code 1' }, ...almost, DONE]
  const { queue, clock } = rig(db, {
    handlers: {
      cv: async () => {
        const [first = DONE, ...rest] = results
        results = rest
        return first
      },
    },
  })
  const id = valueOf(queue.add({ kind: 'cv', ref: 'a1' })).id
  while (results.length > 0) {
    await queue.settled()
    clock.advance(30 * MINUTE)
    queue.pump()
  }
  await queue.settled()
  assert.deepEqual([workOf(db, id).state, workOf(db, id).attempts], ['done', 1], 'only the real failure counted')
})
