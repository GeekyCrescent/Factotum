import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { REMOVE_PORTFOLIO_INSTRUCTION } from '../ai/prompts/rewrite.ts'
import { instructionEvent } from '../ai/returns.ts'
import { appOf, eventsOf, insertApp, queueStore, rig, workOf } from '../ai/test-queue.ts'
import type { Queue } from '../ai/queue.ts'
import { loadProfileSeed } from '../profile.ts'
import { appTransition } from '../state.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { NOW, valueOf } from '../test-state.ts'
import { eventually, realTimers, tempBase, type ManualClock } from '../test-support.ts'
import { fail, ok, type Artifacts, type CvDoc } from '../types.ts'
import { createRewriteHandler, type PrintFn, type RewriteDeps } from './rewrite.ts'

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-claude.mjs', import.meta.url))
chmodSync(FAKE, 0o755)

const CV: CvDoc = { headline: 'Engineer', summary: 'Builds.', experience: [], projects: [], education: [], certifications: [], skills: [], gaps: [] }
const BODY = 'Dear Ada,\n\nMy work: {portfolio}.\n\n{signature}'

const ARTIFACTS: Artifacts = {
  version: 1,
  cv: CV,
  pdf: 'artifacts/a1/v1/cv.pdf',
  png: 'artifacts/a1/v1/cv.png',
  contactHash: 'hash-1',
  letter: { subject: 'Application', body: BODY },
  form: [{ question: 'Where?', answer: 'From {suburb}.', ok: true, hint: null }],
  skills: null,
  linkedin: null,
  profileVersion: 2,
  rules: [],
  usage: null,
  origin: 'seed',
}

const answer = (overrides: Record<string, unknown> = {}) => ({
  cv: CV,
  letter: { subject: 'Application', body: 'Dear Ada,\n\nShorter. {portfolio}\n\n{signature}' },
  form: [{ question: 'Where?', answer: 'From {suburb}.' }],
  linkedin: null,
  ...overrides,
})

interface World {
  readonly db: Db
  readonly queue: Queue
  readonly clock: ManualClock
  readonly runDir: string
  readonly prints: number[]
  readonly answer: (value: unknown) => void
}

async function world(print?: PrintFn, overrides: Partial<RewriteDeps> = {}): Promise<World> {
  const base = tempBase()
  const db = await queueStore(base)
  const profile = valueOf(loadProfileSeed())
  valueOf(
    db.tx((q) => {
      repo.insertProfileVersion(q, { version: 2, createdAt: NOW.toISOString(), profile }, { kind: 'profile-saved' }, NOW)
      return ok(undefined)
    }),
  )
  const runDir = join(base.dir, 'run')
  mkdirSync(runDir, { recursive: true })
  const prints: number[] = []
  let clockRef: ManualClock | undefined
  const handler = createRewriteHandler({
    db,
    now: () => clockRef?.now() ?? NOW,
    timers: realTimers,
    stateDir: base.dir,
    runDir,
    claude: { model: 'sonnet', effort: undefined, bin: FAKE },
    readFixed: () => ok({ master: 'MASTER', guide: 'GUIDE' }),
    print:
      print ??
      (async ({ version }) => {
        prints.push(version)
        return ok({ pdf: `artifacts/a1/v${version}/cv.pdf`, png: `artifacts/a1/v${version}/cv.png`, contactHash: `hash-${version}` })
      }),
    ...overrides,
  })
  const { queue, clock } = rig(db, { handlers: { rewrite: handler } })
  clockRef = clock
  return { db, queue, clock, runDir, prints, answer: (value) => writeFileSync(join(runDir, 'fake-claude.answer'), JSON.stringify(value)) }
}

/** T-A7 as the review writes it: `rewriting`, the instruction event, and a `rewrite` queued. */
function instruct(w: World, id: string, text: string): string {
  return valueOf(
    w.db.tx((q) => {
      const app = repo.getApplication(q, id)
      if (app === undefined) return fail<string>('not-found', 'no app')
      const moved = appTransition(app, { type: 'instruction', hasLetter: true }, NOW)
      if (!moved.ok) return moved
      const saved = repo.saveApplication(q, moved.value, instructionEvent(text), NOW)
      if (!saved.ok) return saved
      const work = w.queue.enqueue(q, { kind: 'rewrite', ref: id })
      return work.ok ? ok(work.value.id) : work
    }),
  )
}

const run = async (w: World, workId: string, attempts: number): Promise<void> => {
  w.queue.pump()
  await eventually(() => workOf(w.db, workId).attempts >= attempts || workOf(w.db, workId).state === 'done', `work ran ${attempts}`)
  await w.queue.settled()
}

describe('the rewrite of an application (R2, design D10)', () => {
  test('it comes back as a new version, origin rewritten, and the application leaves rewriting', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' }, ARTIFACTS)
    w.answer(answer())
    const workId = instruct(w, 'a1', 'Make it shorter')
    await run(w, workId, 0)
    assert.equal(workOf(w.db, workId).state, 'done')
    const app = appOf(w.db, 'a1')
    assert.equal(app.state, 'ready')
    assert.equal(app.version, 2)
    const v2 = w.db.read((q) => repo.getArtifacts(q, 'a1', 2))
    assert.equal(v2?.origin, 'rewritten')
    assert.equal(v2?.letter?.body, 'Dear Ada,\n\nShorter. {portfolio}\n\n{signature}')
    assert.equal(v2?.pdf, ARTIFACTS.pdf, 'the CV did not change: the same PDF')
    assert.deepEqual(w.prints, [], 'nothing reprinted')
    assert.ok(eventsOf(w.db, 'a1').some((e) => e.kind === 'rewritten'))
    const prompt = readFileSync(join(w.runDir, 'fake-claude.prompt.1'), 'utf8')
    assert.ok(prompt.includes('<instruction>Make it shorter</instruction>'))
  })

  test('a CV that changed is printed again, as the new version', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' }, ARTIFACTS)
    w.answer(answer({ cv: { ...CV, headline: 'Graduate engineer' } }))
    const workId = instruct(w, 'a1', 'Change the headline')
    await run(w, workId, 0)
    assert.deepEqual(w.prints, [2])
    const v2 = w.db.read((q) => repo.getArtifacts(q, 'a1', 2))
    assert.equal(v2?.cv?.headline, 'Graduate engineer')
    assert.equal(v2?.pdf, 'artifacts/a1/v2/cv.pdf')
    assert.equal(v2?.contactHash, 'hash-2')
  })

  test('a print that fails is a failed attempt', async () => {
    const w = await world(async () => fail('module-error', 'chromium failed'))
    insertApp(w.db, { id: 'a1', state: 'ready' }, ARTIFACTS)
    w.answer(answer({ cv: { ...CV, headline: 'Other' } }))
    const workId = instruct(w, 'a1', 'Change the headline')
    await run(w, workId, 1)
    assert.equal(workOf(w.db, workId).state, 'queued')
    assert.match(workOf(w.db, workId).reason ?? '', /print/)
  })

  test('an answer that loses {signature} is an attempt: back to the queue', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' }, ARTIFACTS)
    w.answer(answer({ letter: { subject: 'Application', body: 'Dear Ada,\n\n{portfolio}\n\nJuan' } }))
    const workId = instruct(w, 'a1', 'Sign it')
    await run(w, workId, 1)
    const work = workOf(w.db, workId)
    assert.equal(work.state, 'queued')
    assert.equal(work.reason, 'slots')
    assert.equal(appOf(w.db, 'a1').state, 'rewriting')
    assert.equal(appOf(w.db, 'a1').version, 1)
  })

  test('an answer that fills {portfolio} with a URL is an attempt', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' }, ARTIFACTS)
    w.answer(answer({ letter: { subject: 'Application', body: 'Dear Ada,\n\nhttps://github.com/me\n\n{signature}' } }))
    const workId = instruct(w, 'a1', 'Add my GitHub')
    await run(w, workId, 1)
    assert.equal(workOf(w.db, workId).reason, 'slots')
  })

  test('three in a row: back to rewriteFrom with rewrite-failed { reason: slots }', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' }, ARTIFACTS)
    w.answer(answer({ letter: { subject: 'Application', body: 'Dear Ada,\n\n{portfolio}' } }))
    const workId = instruct(w, 'a1', 'Shorter')
    await run(w, workId, 1)
    w.clock.advance(2 * 60_000)
    await run(w, workId, 2)
    w.clock.advance(10 * 60_000)
    await run(w, workId, 3)
    assert.equal(workOf(w.db, workId).state, 'failed')
    const app = appOf(w.db, 'a1')
    assert.equal(app.state, 'ready')
    assert.equal(app.version, 1)
    const failed = eventsOf(w.db, 'a1').find((e) => e.kind === 'rewrite-failed')
    assert.deepEqual(failed?.data, { instruction: 'Shorter', reason: 'slots' })
  })

  test('«Remove the portfolio line» may remove {portfolio}', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'in-review' }, ARTIFACTS)
    w.answer(answer({ letter: { subject: 'Application', body: 'Dear Ada,\n\n{signature}' } }))
    const workId = instruct(w, 'a1', REMOVE_PORTFOLIO_INSTRUCTION)
    await run(w, workId, 0)
    assert.equal(workOf(w.db, workId).state, 'done')
    const prompt = readFileSync(join(w.runDir, 'fake-claude.prompt.1'), 'utf8')
    assert.ok(prompt.includes('you may remove {portfolio}'))
  })

  test('«Remove the portfolio line» may not add another', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'in-review' }, ARTIFACTS)
    w.answer(answer({ letter: { subject: '{portfolio}', body: 'Dear Ada,\n\n{signature}' } }))
    const workId = instruct(w, 'a1', REMOVE_PORTFOLIO_INSTRUCTION)
    await run(w, workId, 1)
    assert.equal(workOf(w.db, workId).reason, 'slots')
  })

  test('a different number of form answers is out of the schema', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'ready' }, ARTIFACTS)
    w.answer(answer({ form: [] }))
    const workId = instruct(w, 'a1', 'Shorter')
    await run(w, workId, 1)
    assert.equal(workOf(w.db, workId).reason, 'form-answers')
  })

  test('a CV that was null stays null, whatever comes back', async () => {
    const w = await world()
    insertApp(w.db, { id: 'a1', state: 'in-review' }, { ...ARTIFACTS, cv: null, pdf: null, png: null })
    w.answer(answer())
    const workId = instruct(w, 'a1', 'Shorter')
    await run(w, workId, 0)
    assert.equal(w.db.read((q) => repo.getArtifacts(q, 'a1', 2))?.cv, null)
    assert.deepEqual(w.prints, [])
  })

  test('what it cannot read is a failed run, with its reason', async () => {
    const w = await world(undefined, { readFixed: () => fail('module-error', 'cv-maestro not found') })
    insertApp(w.db, { id: 'a1', state: 'ready' }, ARTIFACTS)
    const workId = instruct(w, 'a1', 'Shorter')
    await run(w, workId, 1)
    assert.equal(workOf(w.db, workId).reason, 'cv-maestro not found')
  })

  test('a work whose entity is gone is a failed run', async () => {
    const w = await world()
    const handler = createRewriteHandler({
      db: w.db,
      now: () => NOW,
      timers: realTimers,
      stateDir: w.runDir,
      runDir: w.runDir,
      claude: { model: 'sonnet', effort: undefined, bin: FAKE },
      readFixed: () => ok({ master: '', guide: '' }),
      print: async () => fail('module-error', 'unused'),
    })
    const result = await handler(
      { id: 'w', kind: 'rewrite', ref: 'nobody', lane: 'interactive', state: 'running', attempts: 0, notBefore: null, reason: null, createdAt: '', updatedAt: '' },
      { signal: new AbortController().signal, timeoutMs: 1000 },
    )
    assert.deepEqual(result, { ok: false, kind: 'failed', reason: 'no such application' })
  })
})
