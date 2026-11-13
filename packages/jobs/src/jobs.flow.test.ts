/**
 * C1 — the facade composed end to end over the fixture seed: import, the CVs back through the real
 * builder (fake binaries), the batch as the screen sees it (with `seen`), `decide`, the files, «Close»,
 * the profile's re-lint, and the test application kept out of the overview.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import { createTestApplication } from './dev/test-application.ts'
import type { ApplicationCard, Jobs } from './facade/types.ts'
import { openDb } from './store/db.ts'
import { depsOf, NOW, rigIn, started, type Rig } from './test-jobs.ts'
import { errorOf, valueOf } from './test-state.ts'
import { eventually, tempBase } from './test-support.ts'

async function imported(base: { readonly dir: string }): Promise<{ readonly jobs: Jobs; readonly rig: Rig }> {
  const rig = rigIn(base.dir)
  const jobs = await started(depsOf(rig))
  const report = valueOf(await jobs.importSeed({ dryRun: false }))
  assert.ok(report.queued.cv > 0, 'CVs queued')
  await eventually(() => (jobs.overview().counts.generating ?? 0) === 0, 'every CV came back', 30_000)
  return { jobs, rig }
}

const cards = (jobs: Jobs): readonly ApplicationCard[] =>
  valueOf(jobs.batch()).batch?.items.flatMap((item) => (item.kind === 'application' ? [item.application] : [])) ?? []

test('C1 flow: import, CVs back, a batch whose items carry seen and filled texts; decide checks seen', async () => {
  using base = tempBase()
  const { jobs } = await imported(base)
  try {
    assert.equal(valueOf(jobs.batch()).batch, null, 'no batch open yet')
    const answer = valueOf(jobs.startBatch())
    const batch = answer.batch
    if (batch === null) assert.fail('a batch')
    assert.ok(batch.items.length > 0)
    assert.equal(batch.test, false)
    for (const item of batch.items) assert.match(item.seen, /^[0-9a-f]{64}$/)
    const card = cards(jobs).find((c) => c.letter !== null)
    if (card === undefined) assert.fail('an application with a letter')
    assert.ok(!card.letter?.body.includes('{signature}'), 'shown filled')
    assert.ok(card.company.name !== '')
    if (card.cv.pdf !== null) assert.match(card.cv.pdf, new RegExp(`^a/${card.id}/v/${card.version}/.+-CV\\.pdf$`))

    const first = batch.items[0]
    if (first === undefined) assert.fail('an item')
    errorOf(jobs.decide({ itemId: first.itemId, kind: 'skip', reason: 'not-now', seen: 'f'.repeat(64) }), 'conflict')
    errorOf(jobs.decide({ itemId: first.itemId, kind: 'nope' }), 'invalid')
    errorOf(jobs.decide('not an object'), 'invalid')
    const decided = valueOf(jobs.decide({ itemId: first.itemId, kind: 'skip', reason: 'not-now', seen: first.seen }))
    assert.equal(decided.result, 'skipped')
  } finally {
    await jobs.stop()
  }
})

test('C1 flow: file() reads the path of the artifacts row, confined to artifacts/; close() closes with a reason', async () => {
  using base = tempBase()
  const { jobs } = await imported(base)
  try {
    valueOf(jobs.startBatch())
    const printed = cards(jobs).find((c) => c.cv.pdf !== null)
    if (printed === undefined) assert.fail('a printed CV')
    const pdf = valueOf(jobs.file(printed.id, printed.version, 'pdf'))
    assert.ok(pdf.endsWith('.pdf') && existsSync(pdf))
    assert.ok(valueOf(jobs.file(printed.id, printed.version, 'png')).endsWith('.png'))
    errorOf(jobs.file(printed.id, printed.version + 9, 'pdf'), 'not-found')
    errorOf(jobs.file('nope', 1, 'png'), 'not-found')

    errorOf(jobs.close(printed.id, { reason: '' }), 'invalid')
    assert.equal(valueOf(jobs.close(printed.id, { reason: 'filled elsewhere' })).state, 'closed')
    const detail = valueOf(jobs.application(printed.id))
    assert.equal(detail.application.state, 'closed')
    assert.ok(detail.events.some((e) => e.kind === 'closed'))
    errorOf(jobs.application('nope'), 'not-found')
  } finally {
    await jobs.stop()
  }
})

test('C1 flow: saveProfile re-lints in its tx; saveRule too; a bad profile is invalid', async () => {
  using base = tempBase()
  const { jobs } = await imported(base)
  try {
    const before = jobs.overview().counts.ready ?? 0
    assert.ok(before > 0)
    const profile = jobs.profile().profile
    const saved = valueOf(jobs.saveProfile({ ...profile, identity: { ...profile.identity, phone: '' } }))
    assert.equal(saved.version, 2)
    assert.ok(saved.relinted >= before, 'the ready ones went back for the phone')
    assert.equal(jobs.overview().counts.ready ?? 0, 0)
    errorOf(jobs.saveProfile({ nope: true }), 'invalid')

    const rule = valueOf(jobs.saveRule({ text: 'Always be brief.', scope: 'all' }))
    assert.equal(rule.relinted, 0)
    assert.deepEqual(jobs.rules().map((r) => r.text), ['Always be brief.'])
    assert.equal(valueOf(jobs.saveRule({ enabled: false }, rule.id)).enabled, false)
  } finally {
    await jobs.stop()
  }
})

test('C1 flow: the test application is not in the overview; retry and the send poll answer from the engine', async () => {
  using base = tempBase()
  const { jobs, rig } = await imported(base)
  try {
    const counts = jobs.overview().counts
    // The CLI's way: a second handle on the same jobs.db, beside the running facade.
    const db = valueOf(await openDb({ dir: rig.stateDir, now: () => NOW }))
    const test = valueOf(createTestApplication(db, { now: () => NOW }, { to: 'owner@example.test' }))
    db.close()
    assert.deepEqual(jobs.overview().counts, counts, 'not counted')
    assert.equal(valueOf(jobs.application(test.id)).application.test, true)

    errorOf(jobs.retry(test.id, 'reprint'), 'conflict', 'reprint arrives with H5c')
    errorOf(jobs.retry(test.id, 'cv'), 'conflict')
    errorOf(jobs.send(test.id, 'initial'), 'not-found')
    errorOf(jobs.retrySend(test.id, 'initial'), 'conflict')
    errorOf(jobs.resolveUnknown(test.id, 'initial', 'went'), 'conflict')
    errorOf(jobs.markSent(test.id, 'initial'), 'conflict')
  } finally {
    await jobs.stop()
  }
})
