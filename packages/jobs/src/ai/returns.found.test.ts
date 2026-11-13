import { test } from 'node:test'
import assert from 'node:assert/strict'

import { valueOf } from '../test-state.ts'
import { tempBase } from '../test-support.ts'
import type { CvDoc, Warning } from '../types.ts'
import type { ArtifactsPatch, JobResult } from './queue.ts'
import { appOf, controlled, insertApp, queueStore, rig } from './test-queue.ts'

const CV: CvDoc = { headline: 'h', summary: 's', experience: [], projects: [], education: [], certifications: [], skills: [], gaps: [] }
const PATCH: ArtifactsPatch = { cv: CV, pdf: '/state/cv.pdf', png: null, contactHash: 'hash', profileVersion: 1, rules: [], usage: null, origin: 'generated' }
const claim = (where: Warning['where'], detail: string, overridden: Warning['overridden'] = null): Warning => ({
  code: 'unsupported-claim',
  where,
  detail,
  blocks: true,
  overridden,
})
const LINTED: Warning = { code: 'too-long', where: 'letter', detail: '230 words', blocks: false, overridden: null }

const back = (patch: Partial<ArtifactsPatch>, warnings?: readonly Warning[]): JobResult => ({
  ok: true,
  output: { type: 'application', artifacts: { ...PATCH, ...patch }, ...(warnings === undefined ? {} : { warnings }) },
})

test('a CV that comes back before its letter keeps the verifier’s warnings until the letter settles the application', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  insertApp(db)
  const cv = controlled()
  const letter = controlled()
  const { queue } = rig(db, { handlers: { cv: cv.handler, letter: letter.handler }, lint: () => [LINTED] })
  valueOf(db.tx((q) => queue.enqueueCv(q, 'app-1')))
  valueOf(db.tx((q) => queue.enqueue(q, { kind: 'letter', ref: 'app-1' })))
  queue.pump()

  cv.finish(cv.started()[0]!, back({}, [claim('cv', 'led 12 people')]))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(appOf(db, 'app-1').state, 'generating', 'the letter is still on its way')
  const letterOnly: ArtifactsPatch = { letter: { subject: null, body: 'New letter {signature}' }, profileVersion: 1, rules: [], usage: null, origin: 'generated' }
  letter.finish(letter.started()[0]!, { ok: true, output: { type: 'application', artifacts: letterOnly } })
  await queue.settled()

  const app = appOf(db, 'app-1')
  assert.equal(app.state, 'in-review')
  assert.deepEqual(app.warnings, [LINTED, claim('cv', 'led 12 people')])
})

test('a rewrite that brings a new CV replaces the CV’s warnings of the verifier, and keeps the letter’s with its «I checked it»', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const checked = claim('letter', 'won an award', { at: '2026-11-14T00:00:00.000Z' })
  insertApp(db, { state: 'rewriting', rewriteFrom: 'in-review', warnings: [claim('cv', 'old claim'), checked] })
  const rewrite = controlled()
  const { queue } = rig(db, { handlers: { rewrite: rewrite.handler } })
  valueOf(db.tx((q) => queue.enqueue(q, { kind: 'rewrite', ref: 'app-1' })))
  queue.pump()
  rewrite.finish(rewrite.started()[0]!, back({}, []))
  await queue.settled()

  const app = appOf(db, 'app-1')
  assert.deepEqual(app.warnings, [checked])
  assert.equal(app.state, 'ready')
})
