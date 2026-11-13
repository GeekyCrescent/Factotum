import { test } from 'node:test'
import assert from 'node:assert/strict'
import { followupTransition } from '../state.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { BLOCKER, followupVersion, NOW, valueOf } from '../test-state.ts'
import { eventually, tempBase } from '../test-support.ts'
import { ok, type CvDoc } from '../types.ts'
import { instructionEvent, type JobResult, type LintTarget } from './queue.ts'
import { appOf, controlled, eventsOf, insertApp, insertFollowup, queueStore, rig, workOf } from './test-queue.ts'

const cvDoc = (headline: string): CvDoc => ({ headline, summary: 's', experience: [], projects: [], education: [], certifications: [], skills: [], gaps: [] })
const cvBack = (headline: string): JobResult => ({
  ok: true,
  output: { type: 'application', artifacts: { cv: cvDoc(headline), pdf: `/state/${headline}.pdf`, png: null, contactHash: 'h', profileVersion: 1, rules: [], usage: null, origin: 'generated' } },
})
const letterBack = (body: string): JobResult => ({
  ok: true,
  output: { type: 'application', artifacts: { letter: { subject: 'Hi', body }, profileVersion: 1, rules: [], usage: null, origin: 'generated' } },
})

const enqueue = (db: Db, queue: ReturnType<typeof rig>['queue'], kind: 'cv' | 'letter' | 'rewrite' | 'reprint', ref = 'app-1'): string =>
  valueOf(db.tx((q) => queue.enqueue(q, { kind, ref }))).id

test('G4: a cv superseded by a newer cv request is discarded (prepared { discarded: true, kind }); the newer one is saved', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const run = controlled()
  // Concurrency 3: two bulk at once (D10 keeps the third slot for interactive).
  const { queue } = rig(db, { concurrency: 3, handlers: { cv: run.handler } })
  insertApp(db, { state: 'generating' })
  const old = enqueue(db, queue, 'cv')
  queue.pump()
  const newer = enqueue(db, queue, 'cv')
  queue.pump()
  assert.deepEqual(run.started(), [old, newer])
  run.finish(old, cvBack('old'))
  await eventually(() => workOf(db, old).state === 'done', 'the old one written')
  assert.equal(appOf(db, 'app-1').version, 1, 'nothing saved')
  const discarded = eventsOf(db, 'app-1').at(-1)
  assert.deepEqual([discarded?.kind, discarded?.data], ['prepared', { discarded: true, kind: 'cv', workId: old }])
  assert.equal(appOf(db, 'app-1').state, 'generating')
  run.finish(newer, cvBack('new'))
  await queue.settled()
  const app = appOf(db, 'app-1')
  assert.deepEqual([app.state, app.version], ['ready', 2])
  assert.equal(db.read((q) => repo.getArtifacts(q, 'app-1', 2))?.cv?.headline, 'new')
})

for (const order of [['cv', 'letter'], ['letter', 'cv']] as const) {
  test(`G4 (crit. 65): a letter and a CV queued together come back ${order.join(' then ')}: both are saved, and generating ends only with the second`, async () => {
    using base = tempBase()
    const db = await queueStore(base)
    const run = controlled()
    const { queue } = rig(db, { concurrency: 3, handlers: { cv: run.handler, letter: run.handler } })
    insertApp(db, { state: 'generating' }, null)
    const ids = { cv: enqueue(db, queue, 'cv'), letter: enqueue(db, queue, 'letter') }
    queue.pump()
    const [first, second] = order
    run.finish(ids[first], first === 'cv' ? cvBack('cv') : letterBack('the letter'))
    await eventually(() => workOf(db, ids[first]).state === 'done', 'the first written')
    assert.deepEqual([appOf(db, 'app-1').state, appOf(db, 'app-1').version], ['generating', 1])
    run.finish(ids[second], second === 'cv' ? cvBack('cv') : letterBack('the letter'))
    await queue.settled()
    const app = appOf(db, 'app-1')
    assert.deepEqual([app.state, app.version], ['ready', 2])
    const both = db.read((q) => repo.getArtifacts(q, 'app-1', 2))
    assert.deepEqual([both?.cv?.headline, both?.letter?.body, both?.pdf], ['cv', 'the letter', '/state/cv.pdf'])
  })
}

test('G4: a newer cv discards the old cv but NOT the letter', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const run = controlled()
  const { queue } = rig(db, { concurrency: 4, handlers: { cv: run.handler, letter: run.handler } })
  insertApp(db, { state: 'generating' }, null)
  const oldCv = enqueue(db, queue, 'cv')
  const letter = enqueue(db, queue, 'letter')
  const newCv = enqueue(db, queue, 'cv')
  queue.pump()
  run.finish(oldCv, cvBack('old'))
  run.finish(letter, letterBack('kept'))
  await eventually(() => workOf(db, letter).state === 'done' && workOf(db, oldCv).state === 'done', 'both written')
  assert.equal(appOf(db, 'app-1').version, 1, 'only the letter made a version')
  assert.equal(db.read((q) => repo.getArtifacts(q, 'app-1', 1))?.letter?.body, 'kept')
  run.finish(newCv, cvBack('new'))
  await queue.settled()
  const latest = db.read((q) => repo.getArtifacts(q, 'app-1', appOf(db, 'app-1').version))
  assert.deepEqual([latest?.cv?.headline, latest?.letter?.body], ['new', 'kept'])
})

test('G4: what comes back late to a closed application is kept as a version, and the state is not touched', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const run = controlled()
  const { queue } = rig(db, { handlers: { cv: run.handler } })
  insertApp(db, { state: 'generating' })
  const id = enqueue(db, queue, 'cv')
  queue.pump()
  valueOf(db.tx((q) => repo.saveApplication(q, { ...appOf(db, 'app-1'), state: 'closed', outcome: 'dropped' }, { kind: 'closed', data: { reason: 'not now' } }, NOW)))
  run.finish(id, cvBack('late'))
  await queue.settled()
  const app = appOf(db, 'app-1')
  assert.deepEqual([app.state, app.version], ['closed', 2])
  assert.deepEqual(eventsOf(db, 'app-1').at(-1)?.data, { kind: 'cv', version: 2, workId: id })
})

test('G4: back to generating, the injected lint decides: a block → in-review with it', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const linted: LintTarget[] = []
  const { queue } = rig(db, {
    handlers: { cv: async () => cvBack('cv') },
    lint: (_q, target) => {
      linted.push(target)
      return [BLOCKER]
    },
  })
  insertApp(db)
  valueOf(db.tx((q) => queue.enqueueCv(q, 'app-1')))
  queue.pump()
  await queue.settled()
  const app = appOf(db, 'app-1')
  assert.deepEqual([app.state, app.warnings], ['in-review', [BLOCKER]])
  assert.equal(linted[0]?.kind === 'application' && linted[0].artifacts.version, 2)
})

test('G4: a pdf that is not on disk keeps it in-review even with a clean lint (T-A2)', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue } = rig(db, { handlers: { cv: async () => cvBack('cv') }, pdfExists: () => false })
  insertApp(db)
  valueOf(db.tx((q) => queue.enqueueCv(q, 'app-1')))
  queue.pump()
  await queue.settled()
  assert.equal(appOf(db, 'app-1').state, 'in-review')
})

test('G4: a reprint back on an application in-review or ready is saved and the injected relintOne runs (T-A5)', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const relinted: unknown[] = []
  const { queue } = rig(db, {
    handlers: { reprint: async () => cvBack('reprinted') },
    relintOne: (_q, entity) => {
      relinted.push(entity)
      return ok(undefined)
    },
  })
  insertApp(db, { state: 'in-review' })
  queue.add({ kind: 'reprint', ref: 'app-1' })
  await queue.settled()
  assert.deepEqual(relinted, [{ kind: 'application', id: 'app-1' }])
  assert.equal(appOf(db, 'app-1').version, 2)
})

test('G4: a rewrite of an application writes letter AND cv requests, and coming back moves rewriting → ready (T-A8)', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const both: JobResult = {
    ok: true,
    output: { type: 'application', artifacts: { cv: cvDoc('cv'), pdf: '/state/cv.pdf', letter: { subject: 'Hi', body: 'rewritten' }, profileVersion: 1, rules: [], usage: null, origin: 'rewritten' } },
  }
  const { queue } = rig(db, { handlers: { rewrite: async () => both } })
  insertApp(db, { state: 'rewriting', rewriteFrom: 'ready' })
  const id = enqueue(db, queue, 'rewrite')
  assert.deepEqual(db.read((q) => repo.genRequestsOf(q, 'app-1')).map((r) => [r.kind, r.workId]), [['cv', id], ['letter', id]])
  queue.pump()
  await queue.settled()
  const app = appOf(db, 'app-1')
  assert.deepEqual([app.state, app.version, app.rewriteFrom], ['ready', 2, null])
  assert.equal(eventsOf(db, 'app-1').at(-1)?.kind, 'rewritten')
})

test('G4: a rewrite superseded by a newer cv request is discarded whole', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const run = controlled()
  const { queue } = rig(db, { handlers: { rewrite: run.handler, cv: run.handler } })
  insertApp(db, { state: 'rewriting', rewriteFrom: 'in-review' })
  const rewrite = enqueue(db, queue, 'rewrite')
  enqueue(db, queue, 'cv')
  queue.pump()
  run.finish(rewrite, letterBack('rewritten'))
  await eventually(() => workOf(db, rewrite).state === 'done', 'written')
  assert.deepEqual([appOf(db, 'app-1').state, appOf(db, 'app-1').version], ['rewriting', 1])
  assert.deepEqual(eventsOf(db, 'app-1').at(-1)?.data, { discarded: true, kind: 'rewrite', workId: rewrite })
})

test('G4: a superseded work that fails for good moves nothing', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const run = controlled()
  const { queue } = rig(db, { handlers: { rewrite: run.handler } })
  insertApp(db, { state: 'rewriting', rewriteFrom: 'ready' })
  const old = enqueue(db, queue, 'rewrite')
  valueOf(db.tx((q) => repo.saveWork(q, { ...workOf(db, old), attempts: 2 })))
  queue.pump()
  enqueue(db, queue, 'rewrite')
  run.finish(old, { ok: false, kind: 'failed', reason: 'x' })
  await eventually(() => workOf(db, old).state === 'failed', 'failed for good')
  assert.equal(appOf(db, 'app-1').state, 'rewriting')
})

test('G4: a follow-up rewrite comes back as a new version of THAT row (T-F4); one not rewriting is kept and re-linted', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const relinted: unknown[] = []
  const back: JobResult = { ok: true, output: { type: 'followup', version: { subject: null, body: 'Warmer {signature}', profileVersion: 1, rules: [], usage: null } } }
  const { queue } = rig(db, {
    handlers: { rewrite: async () => back },
    relintOne: (_q, entity) => {
      relinted.push(entity)
      return ok(undefined)
    },
  })
  insertApp(db, { state: 'sent' })
  const row = insertFollowup(db, { state: 'ready' })
  valueOf(
    db.tx((q) => {
      const saved = repo.saveFollowup(q, valueOf(followupTransition(row, { type: 'instruction' }, NOW)), instructionEvent('warmer'), NOW)
      return saved.ok ? queue.enqueue(q, { kind: 'rewrite', ref: 'fu-1' }) : saved
    }),
  )
  queue.pump()
  await queue.settled()
  const rewritten = db.read((q) => repo.getFollowup(q, 'fu-1'))
  assert.deepEqual([rewritten?.state, rewritten?.version, rewritten?.versions.at(-1)?.origin, rewritten?.versions.at(-1)?.instruction], ['ready', 2, 'rewritten', 'warmer'])

  insertFollowup(db, { id: 'fu-2', n: 2, state: 'draft', versions: [followupVersion(1)] })
  queue.add({ kind: 'rewrite', ref: 'fu-2' })
  await queue.settled()
  const kept = db.read((q) => repo.getFollowup(q, 'fu-2'))
  assert.deepEqual([kept?.state, kept?.version], ['draft', 2])
  assert.deepEqual(relinted, [{ kind: 'followup', id: 'fu-2' }])
})
