import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW, valueOf } from '../test-state.ts'
import { tempBase } from '../test-support.ts'
import type { CvDoc } from '../types.ts'
import type { JobResult, LintFn } from './queue.ts'
import { appOf, eventsOf, insertApp, queueStore, rig, workOf } from './test-queue.ts'

const MINUTE = 60_000
const CV: CvDoc = { headline: 'h', summary: 's', experience: [], projects: [], education: [], certifications: [], skills: [], gaps: [] }
const CV_BACK: JobResult = {
  ok: true,
  output: { type: 'application', artifacts: { cv: CV, pdf: '/state/cv.pdf', png: null, contactHash: 'hash', profileVersion: 1, rules: [], usage: null, origin: 'generated' } },
}
const THROWS: LintFn = () => {
  throw new Error('the linter broke')
}

test('a return that cannot be written goes through the failure path: an attempt, a retry, an event, a log — never stuck running', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  insertApp(db)
  const { queue, log } = rig(db, { lint: THROWS, handlers: { cv: async () => CV_BACK } })
  valueOf(db.tx((q) => queue.enqueueCv(q, 'app-1')))
  queue.pump()
  await queue.settled()
  const [work] = db.read((q) => q.all<{ id: string }>('SELECT id FROM work'))
  const row = workOf(db, work!.id)
  assert.deepEqual([row.state, row.attempts, row.reason, row.notBefore], ['queued', 1, 'result-not-written', new Date(NOW.getTime() + 2 * MINUTE).toISOString()])
  assert.equal(appOf(db, 'app-1').state, 'generating', 'the entity is the next attempt’s to move')
  const last = eventsOf(db, 'app-1').at(-1)
  assert.deepEqual([last?.kind, last?.data], ['prepared', { kind: 'cv', workId: row.id, notWritten: true, reason: 'result-not-written' }])
  assert.ok(log.lines.some((line) => line.startsWith('error ') && line.includes('could not be written') && line.includes('the linter broke')))
})

test('a return that cannot be written three times leaves the work failed, and the queue goes on', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  insertApp(db)
  const { queue, clock } = rig(db, { lint: THROWS, handlers: { cv: async () => CV_BACK } })
  valueOf(db.tx((q) => queue.enqueueCv(q, 'app-1')))
  for (let i = 0; i < 3; i += 1) {
    queue.pump()
    await queue.settled()
    clock.advance(10 * MINUTE)
  }
  const [work] = db.read((q) => q.all<{ id: string }>('SELECT id FROM work'))
  const row = workOf(db, work!.id)
  assert.deepEqual([row.state, row.attempts, row.reason], ['failed', 3, 'result-not-written'])
  assert.deepEqual(queue.running(), [])
})

test('settled() never rejects, and the pump goes on, even when concluding a run throws', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const lines: string[] = []
  let calls = 0
  const { queue } = rig(db, {
    concurrency: 1,
    handlers: {
      classify: async () => {
        calls += 1
        const apply = (): never => {
          throw new Error('apply broke')
        }
        return { ok: true, output: { type: 'apply', apply } }
      },
    },
    // A logger that throws on the conclusion's own line: `conclude` itself blows up.
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: (message: string) => {
        lines.push(message)
        if (message.includes('could not be written')) throw new Error('the logger broke')
      },
    },
  })
  valueOf(queue.add({ kind: 'classify', ref: 'mail-1' }))
  valueOf(queue.add({ kind: 'classify', ref: 'mail-2' }))
  await queue.settled()
  await queue.settled()
  assert.equal(calls, 2, 'the second work still ran')
  assert.deepEqual(queue.running(), [])
  assert.ok(lines.some((line) => line.includes('the logger broke')))
})
