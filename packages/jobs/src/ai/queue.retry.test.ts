import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { appTransition, followupTransition } from '../state.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { NOW, valueOf } from '../test-state.ts'
import { manualTimers, tempBase } from '../test-support.ts'
import type { CvDoc } from '../types.ts'
import type { JobHandler, JobResult, Queue } from './queue.ts'
import { runClaude } from './run.ts'
import { appOf, DONE, eventsOf, insertApp, insertFollowup, queueStore, rig, workOf } from './test-queue.ts'

const MINUTE = 60_000
const FAILS: JobHandler = async () => ({ ok: false, kind: 'failed', reason: 'claude answered outside the schema' })

const CV: CvDoc = { headline: 'h', summary: 's', experience: [], projects: [], education: [], certifications: [], skills: [], gaps: [] }
const CV_BACK: JobResult = {
  ok: true,
  output: { type: 'application', artifacts: { cv: CV, pdf: '/state/cv.pdf', png: null, contactHash: 'hash', profileVersion: 1, rules: [], usage: null, origin: 'generated' } },
}

/** Lets every failure run out its three attempts: 2 and 10 minutes apart. */
async function runOut(queue: Queue, advance: (ms: number) => void): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await queue.settled()
    advance(10 * MINUTE)
    queue.pump()
  }
  await queue.settled()
}

/** An «instruction» on an application or a follow-up, as the review writes it (T-A7, T-F3), and its rewrite queued. */
function instruct(db: Db, queue: Queue, entity: { readonly application: string } | { readonly followup: string }, text: string): void {
  valueOf(
    db.tx((q) => {
      if ('application' in entity) {
        const app = repo.getApplication(q, entity.application)!
        const moved = valueOf(appTransition(app, { type: 'instruction', hasLetter: true }, NOW))
        const saved = repo.saveApplication(q, moved, { kind: 'instruction', data: { instruction: text } }, NOW)
        return saved.ok ? queue.enqueue(q, { kind: 'rewrite', ref: app.id }) : saved
      }
      const row = repo.getFollowup(q, entity.followup)!
      const moved = valueOf(followupTransition(row, { type: 'instruction' }, NOW))
      const saved = repo.saveFollowup(q, moved, { kind: 'instruction', data: { instruction: text } }, NOW)
      return saved.ok ? queue.enqueue(q, { kind: 'rewrite', ref: row.id }) : saved
    }),
  )
}

test('a failed run comes back at 2 min, then at 10, and the third failure leaves it failed with its reason', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue, clock } = rig(db, { handlers: { classify: FAILS } })
  const id = valueOf(queue.add({ kind: 'classify', ref: 'mail-1' })).id
  await queue.settled()
  assert.deepEqual([workOf(db, id).state, workOf(db, id).attempts, workOf(db, id).notBefore], ['queued', 1, new Date(NOW.getTime() + 2 * MINUTE).toISOString()])
  queue.pump()
  assert.deepEqual(queue.running(), [], 'not before its time')
  clock.advance(2 * MINUTE)
  queue.pump()
  await queue.settled()
  assert.deepEqual([workOf(db, id).attempts, workOf(db, id).notBefore], [2, new Date(NOW.getTime() + 12 * MINUTE).toISOString()])
  clock.advance(9 * MINUTE)
  queue.pump()
  assert.deepEqual(queue.running(), [])
  clock.advance(MINUTE)
  queue.pump()
  await queue.settled()
  const failed = workOf(db, id)
  assert.deepEqual([failed.state, failed.attempts, failed.reason], ['failed', 3, 'claude answered outside the schema'])
})

test('X8: a cv that fails three times → in-review with missing-cv, and «Retry» queues a cv', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue, clock } = rig(db, { handlers: { cv: FAILS } })
  insertApp(db)
  valueOf(db.tx((q) => queue.enqueueCv(q, 'app-1')))
  queue.pump()
  await runOut(queue, clock.advance)
  const app = appOf(db, 'app-1')
  assert.equal(app.state, 'in-review')
  assert.deepEqual(app.warnings.map((w) => [w.code, w.blocks]), [['missing-cv', true]])
  const failed = eventsOf(db, 'app-1').at(-1)
  assert.deepEqual([failed?.kind, failed?.data.failed, failed?.data.kinds], ['prepared', true, ['cv']])

  const kinds = valueOf(db.tx((q) => queue.retry(q, 'app-1')))
  assert.deepEqual(kinds, ['cv'])
  const retried = appOf(db, 'app-1')
  assert.equal(retried.state, 'generating')
  assert.deepEqual(retried.warnings, [])
  const requests = db.read((q) => repo.genRequestsOf(q, 'app-1'))
  assert.deepEqual(requests.map((r) => [r.kind, r.state]), [['cv', 'queued']])
  assert.equal(workOf(db, requests[0]!.workId).lane, 'interactive')
  assert.deepEqual(eventsOf(db, 'app-1').at(-1)?.data, { kinds: ['cv'] })
})

test('X8: a «Draft outreach» letter that fails three times with the CV back → missing-letter, the CV kept, «Retry» queues a letter and NOT a cv', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue, clock } = rig(db, { handlers: { cv: async () => CV_BACK, letter: FAILS } })
  insertApp(db, { state: 'generating' }, null)
  valueOf(db.tx((q) => queue.enqueue(q, { kind: 'cv', ref: 'app-1' })))
  valueOf(db.tx((q) => queue.enqueue(q, { kind: 'letter', ref: 'app-1' })))
  queue.pump()
  await runOut(queue, clock.advance)
  const app = appOf(db, 'app-1')
  assert.equal(app.state, 'in-review')
  assert.deepEqual(app.warnings.map((w) => w.code), ['missing-letter'])
  const kept = db.read((q) => repo.getArtifacts(q, 'app-1', app.version))
  assert.deepEqual([kept?.cv, kept?.pdf, kept?.letter], [CV, '/state/cv.pdf', null])

  const cvWork = db.read((q) => repo.genRequestsOf(q, 'app-1')).find((r) => r.kind === 'cv')?.workId
  assert.deepEqual(valueOf(db.tx((q) => queue.retry(q, 'app-1'))), ['letter'])
  const requests = db.read((q) => repo.genRequestsOf(q, 'app-1'))
  assert.deepEqual(requests.map((r) => [r.kind, r.state]), [['cv', 'done'], ['letter', 'queued']])
  assert.equal(requests.find((r) => r.kind === 'cv')?.workId, cvWork, 'no new cv')
})

test('X8: both fail → both codes, and «Retry» queues both', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue, clock } = rig(db, { handlers: { cv: FAILS, letter: FAILS } })
  insertApp(db, { state: 'generating' }, null)
  valueOf(db.tx((q) => queue.enqueue(q, { kind: 'cv', ref: 'app-1' })))
  valueOf(db.tx((q) => queue.enqueue(q, { kind: 'letter', ref: 'app-1' })))
  queue.pump()
  await runOut(queue, clock.advance)
  const app = appOf(db, 'app-1')
  assert.equal(app.state, 'in-review')
  assert.deepEqual(app.warnings.map((w) => w.code).sort(), ['missing-cv', 'missing-letter'])
  assert.deepEqual(valueOf(db.tx((q) => queue.retry(q, 'app-1'))), ['cv', 'letter'])
  assert.deepEqual(db.read((q) => repo.genRequestsOf(q, 'app-1')).map((r) => [r.kind, r.state]), [['cv', 'queued'], ['letter', 'queued']])
})

test('«Retry» on an application with nothing failed is a conflict, and writes nothing', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue } = rig(db)
  insertApp(db, { state: 'in-review' })
  const retried = db.tx((q) => queue.retry(q, 'app-1'))
  assert.equal(retried.ok, false)
  assert.equal(db.read((q) => repo.workByState(q, 'queued')).length, 0)
  assert.equal(db.tx((q) => queue.retry(q, 'ghost')).ok, false)
})

test('A4: a rewrite that fails three times goes back to rewriteFrom (ready), same version, rewrite-failed with the whole instruction, and the batch is told', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const told: unknown[] = []
  const { queue, clock } = rig(db, { handlers: { rewrite: FAILS }, onRewriteFailed: (entity) => told.push(entity) })
  insertApp(db, { state: 'ready' })
  instruct(db, queue, { application: 'app-1' }, 'Make it shorter and mention the Sydney hackathon')
  assert.equal(appOf(db, 'app-1').state, 'rewriting')
  queue.pump()
  await runOut(queue, clock.advance)
  const app = appOf(db, 'app-1')
  assert.deepEqual([app.state, app.version, app.rewriteFrom], ['ready', 1, null])
  const last = eventsOf(db, 'app-1').at(-1)
  assert.deepEqual([last?.kind, last?.data], ['rewrite-failed', { instruction: 'Make it shorter and mention the Sydney hackathon', reason: 'claude answered outside the schema' }])
  assert.deepEqual(told, [{ kind: 'application', id: 'app-1' }])
})

test('A4: a follow-up rewrite that fails three times goes back to draft (T-F5), with rewrite-failed { followupId, instruction }', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const told: unknown[] = []
  const { queue, clock } = rig(db, { handlers: { rewrite: FAILS }, onRewriteFailed: (entity) => told.push(entity) })
  insertApp(db, { state: 'sent' })
  insertFollowup(db, { state: 'draft' })
  instruct(db, queue, { followup: 'fu-1' }, 'warmer')
  assert.deepEqual(db.read((q) => repo.genRequestsOf(q, 'fu-1')).map((r) => r.kind), ['followup'])
  queue.pump()
  await runOut(queue, clock.advance)
  const row = db.read((q) => repo.getFollowup(q, 'fu-1'))
  assert.deepEqual([row?.state, row?.version, row?.rewriteFrom], ['draft', 1, null])
  const last = eventsOf(db, 'app-1').at(-1)
  assert.deepEqual([last?.kind, last?.data], ['rewrite-failed', { followupId: 'fu-1', instruction: 'warmer', reason: 'claude answered outside the schema' }])
  assert.deepEqual(told, [{ kind: 'followup', id: 'fu-1' }])
})

test('a reprint that fails three times leaves reprint-failed { reason } and the state alone', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue, clock } = rig(db, { handlers: { reprint: FAILS } })
  insertApp(db, { state: 'in-review' })
  queue.add({ kind: 'reprint', ref: 'app-1' })
  await runOut(queue, clock.advance)
  assert.equal(appOf(db, 'app-1').state, 'in-review')
  assert.deepEqual(eventsOf(db, 'app-1').at(-1)?.data, { reason: 'claude answered outside the schema' })
  assert.equal(eventsOf(db, 'app-1').at(-1)?.kind, 'reprint-failed')
})

// ── The usage limit, with the real run over fake-claude ──────────────────────────────────────────

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-claude.mjs', import.meta.url))

async function fakeClaude(modes: readonly string[]): Promise<{ readonly cwd: string; readonly calls: () => Promise<number> }> {
  const cwd = await mkdtemp(join(tmpdir(), 'factotum-jobs-queue-'))
  await chmod(FAKE, 0o755)
  await writeFile(join(cwd, 'fake-claude.modes'), `${modes.join('\n')}\n`)
  const calls = async (): Promise<number> => {
    try {
      return (await readFile(join(cwd, 'fake-claude.calls'), 'utf8')).trim().split('\n').length
    } catch {
      return 0
    }
  }
  return { cwd, calls }
}

test('R26: a usage limit adds no attempt, pauses the queue until resetsAt, and the resume sends ONE probe before the concurrency opens', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const fake = await fakeClaude(['limit-exit1', 'limit-exit1', 'ok'])
  const timers = manualTimers()
  let now = (): Date => NOW
  const claude: JobHandler = async (work, ctx) => {
    const run = await runClaude({ prompt: work.ref, jsonSchema: '{}', output: z.object({ title: z.string() }), model: 'sonnet', effort: undefined, cwd: fake.cwd, timers: timers.timers, now: () => now(), signal: ctx.signal, timeoutMs: ctx.timeoutMs, bin: FAKE })
    return run.ok ? DONE : run
  }
  // Concurrency 3: two bulk at once (D10 keeps the third slot for interactive).
  const { queue, clock } = rig(db, { concurrency: 3, handlers: { cv: claude } })
  now = clock.now
  const ids = ['a1', 'a2', 'a3'].map((ref) => valueOf(queue.add({ kind: 'cv', ref })).id)
  await queue.settled()
  assert.equal(await fake.calls(), 2)
  assert.equal(queue.pausedUntil(), '2026-11-14T23:01:00.000Z')
  assert.deepEqual(ids.map((id) => [workOf(db, id).state, workOf(db, id).attempts]), [['queued', 0], ['queued', 0], ['queued', 0]])

  clock.set('2026-11-14T23:00:00.000Z')
  queue.pump()
  assert.deepEqual(queue.running(), [], 'nothing leaves while paused')

  clock.set('2026-11-14T23:01:00.000Z')
  queue.pump()
  assert.equal(queue.running().length, 1, 'one probe')
  await queue.settled()
  assert.equal(queue.pausedUntil(), null)
  assert.equal(await fake.calls(), 5, 'after the probe, the other two')
  assert.deepEqual(ids.map((id) => workOf(db, id).state), ['done', 'done', 'done'])
})

test('a limit without an hour pauses 30 min; a probe that hits the limit again pauses again', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  let results: JobResult[] = [
    { ok: false, kind: 'limit', reason: 'claude hit its usage limit' },
    { ok: false, kind: 'limit', reason: 'claude hit its usage limit' },
  ]
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
  await queue.settled()
  assert.equal(queue.pausedUntil(), new Date(NOW.getTime() + 30 * MINUTE).toISOString())
  clock.advance(30 * MINUTE)
  queue.pump()
  await queue.settled()
  assert.equal(queue.pausedUntil(), new Date(NOW.getTime() + 60 * MINUTE).toISOString())
  assert.equal(workOf(db, id).attempts, 0)
  clock.advance(30 * MINUTE)
  queue.pump()
  await queue.settled()
  assert.equal(workOf(db, id).state, 'done')
})

test('a pause does not hold back a reprint: it runs no Claude', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue } = rig(db, { handlers: { cv: async () => ({ ok: false, kind: 'limit', reason: 'x' }), reprint: async () => DONE } })
  queue.add({ kind: 'cv', ref: 'a1' })
  await queue.settled()
  assert.notEqual(queue.pausedUntil(), null)
  const print = valueOf(queue.add({ kind: 'reprint', ref: 'a2' })).id
  await queue.settled()
  assert.equal(workOf(db, print).state, 'done')
})
