import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ImportContext } from '../seed/import.ts'
import * as repo from '../store/repo.ts'
import { errorOf, valueOf } from '../test-state.ts'
import { eventually, tempBase } from '../test-support.ts'
import { appOf, controlled, eventsOf, insertApp, queueStore, rig, workOf } from './test-queue.ts'

test('enqueue writes a queued work row on its lane, oldest first; the default lane follows the kind', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue } = rig(db)
  const cv = valueOf(db.tx((q) => queue.enqueue(q, { kind: 'cv', ref: 'app-1' })))
  const rewrite = valueOf(db.tx((q) => queue.enqueue(q, { kind: 'rewrite', ref: 'app-1' })))
  const bulkLetter = valueOf(db.tx((q) => queue.enqueue(q, { kind: 'letter', ref: 'app-1', lane: 'bulk' })))
  assert.deepEqual([cv.lane, rewrite.lane, bulkLetter.lane], ['bulk', 'interactive', 'bulk'])
  assert.deepEqual(
    [cv, rewrite, bulkLetter].map((w) => [w.state, w.attempts, w.notBefore]),
    [
      ['queued', 0, null],
      ['queued', 0, null],
      ['queued', 0, null],
    ],
  )
  assert.deepEqual(workOf(db, cv.id), cv)
})

test('enqueueCv: T-A1 — gen_requests(id, cv) points to the new work, the application goes generating, with its event', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue } = rig(db)
  insertApp(db)
  // The seed's seam has exactly this shape (S6): C1 passes `queue.enqueueCv` as it is.
  const seam: ImportContext['enqueueCv'] = queue.enqueueCv
  valueOf(db.tx((q) => seam(q, 'app-1')))
  assert.equal(appOf(db, 'app-1').state, 'generating')
  const [request] = db.read((q) => repo.genRequestsOf(q, 'app-1'))
  assert.equal(request?.kind, 'cv')
  const work = workOf(db, request!.workId)
  assert.deepEqual([work.kind, work.ref, work.lane, work.state], ['cv', 'app-1', 'bulk', 'queued'])
  const last = eventsOf(db, 'app-1').at(-1)
  assert.deepEqual([last?.kind, last?.data], ['prepared', { queued: ['cv'], workId: work.id }])
})

test('enqueueCv refuses an application that is not draft, and one that does not exist, writing nothing', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue } = rig(db)
  insertApp(db, { state: 'ready' })
  errorOf(db.tx((q) => queue.enqueueCv(q, 'app-1')), 'conflict')
  errorOf(db.tx((q) => queue.enqueueCv(q, 'ghost')), 'not-found')
  assert.equal(db.read((q) => repo.workByState(q, 'queued')).length, 0)
  assert.equal(db.read((q) => repo.genRequestsOf(q, 'app-1')).length, 0)
})

test('add pumps at once: concurrency 3 starts two bulk (one slot kept for interactive), the rest wait queued', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const run = controlled()
  const { queue } = rig(db, { concurrency: 3, handlers: { cv: run.handler } })
  const ids = ['a1', 'a2', 'a3'].map((ref) => valueOf(queue.add({ kind: 'cv', ref })).id)
  assert.deepEqual(run.started(), ids.slice(0, 2))
  assert.deepEqual(queue.running(), ids.slice(0, 2))
  assert.deepEqual(ids.map((id) => workOf(db, id).state), ['running', 'running', 'queued'])
})

test('R25: 5 bulk and 1 interactive with concurrency 2 → the interactive takes the slot kept for it, at once', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const run = controlled()
  const { queue } = rig(db, { handlers: { cv: run.handler, classify: run.handler } })
  const bulk = ['a1', 'a2', 'a3', 'a4', 'a5'].map((ref) => valueOf(queue.add({ kind: 'cv', ref })).id)
  assert.deepEqual(run.started(), bulk.slice(0, 1), 'bulk takes at most concurrency − 1 slots (D10)')
  const interactive = valueOf(queue.add({ kind: 'classify', ref: 'mail-1' })).id
  assert.deepEqual(run.started(), [bulk[0], interactive], 'the interactive starts at once')
  run.finish(interactive)
  await eventually(() => workOf(db, interactive).state === 'done', 'the interactive done')
  assert.deepEqual(run.started(), [bulk[0], interactive], 'its slot stays free for the next interactive')
  run.finish(bulk[0]!)
  await eventually(() => run.started().length === 3, 'the next slot taken')
  assert.equal(workOf(db, bulk[0]!).state, 'done')
  assert.deepEqual(run.started().at(-1), bulk[1], 'then the bulk goes on in order')
})

test('interactive works may take every slot; with concurrency 1 a bulk still runs', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const run = controlled()
  const { queue } = rig(db, { handlers: { classify: run.handler } })
  const ids = ['m1', 'm2', 'm3'].map((ref) => valueOf(queue.add({ kind: 'classify', ref })).id)
  assert.deepEqual(run.started(), ids.slice(0, 2))
  using other = tempBase()
  const single = controlled()
  const one = rig(await queueStore(other), { concurrency: 1, handlers: { cv: single.handler } })
  const cv = valueOf(one.queue.add({ kind: 'cv', ref: 'a1' })).id
  assert.deepEqual(single.started(), [cv])
})

test('the pump chains works of the same kind (the cache lives 5 min): cv, cv before verify', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const run = controlled()
  const { queue } = rig(db, { concurrency: 1, handlers: { cv: run.handler, verify: run.handler } })
  const first = valueOf(queue.add({ kind: 'cv', ref: 'a1' })).id
  const verify = valueOf(queue.add({ kind: 'verify', ref: 'a1' })).id
  const second = valueOf(queue.add({ kind: 'cv', ref: 'a2' })).id
  run.finish(first)
  await eventually(() => run.started().length === 2, 'the second run')
  run.finish(second)
  await eventually(() => run.started().length === 3, 'the third run')
  assert.deepEqual(run.started(), [first, second, verify])
})

test('reprint runs no Claude: it does not take a slot, and only one runs at a time', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const run = controlled()
  const { queue } = rig(db, { concurrency: 1, handlers: { cv: run.handler, reprint: run.handler } })
  const cv = valueOf(queue.add({ kind: 'cv', ref: 'a1' })).id
  const print1 = valueOf(queue.add({ kind: 'reprint', ref: 'a2' })).id
  const print2 = valueOf(queue.add({ kind: 'reprint', ref: 'a3' })).id
  assert.deepEqual(run.started(), [cv, print1])
  run.finish(print1)
  await eventually(() => run.started().length === 3, 'the second print')
  assert.deepEqual(run.started(), [cv, print1, print2])
})

test('a work with no handler for its kind fails its run with our reason, and the queue goes on', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue } = rig(db)
  const id = valueOf(queue.add({ kind: 'keeper', ref: 'vault' })).id
  await queue.settled()
  assert.equal(workOf(db, id).reason, 'no handler for keeper')
})

test('a handler that throws is a failed run, never an exception out of the pump', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue } = rig(db, { handlers: { classify: () => Promise.reject(new Error('boom')) } })
  const id = valueOf(queue.add({ kind: 'classify', ref: 'mail-1' })).id
  await queue.settled()
  assert.equal(workOf(db, id).reason, 'the classify handler threw: boom')
})

test('the handler gets the work, its abort signal and the timeout of its kind (D10)', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const seen: number[] = []
  const { queue } = rig(db, {
    handlers: {
      cv: async (_work, ctx) => {
        seen.push(ctx.timeoutMs)
        assert.equal(ctx.signal.aborted, false)
        return { ok: false, kind: 'failed', reason: 'x' }
      },
      classify: async (_work, ctx) => {
        seen.push(ctx.timeoutMs)
        return { ok: false, kind: 'failed', reason: 'x' }
      },
    },
  })
  queue.add({ kind: 'cv', ref: 'a1' })
  queue.add({ kind: 'classify', ref: 'm1' })
  await queue.settled()
  assert.deepEqual(seen.sort((a, b) => a - b), [60_000, 180_000])
})
