import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Db } from '../store/db.ts'
import { applicationBySeedKey, eventsOf, getArtifacts, getMeta, setMeta } from '../store/repo.ts'
import { tempBase } from '../test-support.ts'
import { ok } from '../types.ts'
import { noonIn } from './by-hand.ts'
import { importSeed, type ImportReport } from './import.ts'
import { checksSpy, context, count, fixture, HOLD, queueDouble, readerWith, storeWith, vaultOf, WAVE1, WAVE2, ADS } from './test-seed.ts'

// tasks S6b: what was sent by hand (the generic fallback line, v7; design D8 step 8).

function reportOf(result: Awaited<ReturnType<typeof importSeed>>): ImportReport {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.reason}`)
  return result.value
}

const KOOKABURRA_BODY_END = '> Alex Example · alex.example@example.com · [phone] · linkedin.com/in/alex-example\n'
/** Wave 1 with «Sent by hand» on its first entry (Kookaburra, an email entry). */
const wave1Marked = async (day: string): Promise<string> => {
  const markdown = await fixture(WAVE1)
  assert.ok(markdown.includes(KOOKABURRA_BODY_END))
  return markdown.replace(KOOKABURRA_BODY_END, `${KOOKABURRA_BODY_END}\n**Sent by hand:** ${day}\n`)
}
const marked = async (day: string) => readerWith({ [WAVE1]: await wave1Marked(day) })

const app = (db: Db, seedKey: string) => db.read((q) => applicationBySeedKey(q, seedKey))
const NOON_SYDNEY = '2026-11-12T01:00:00.000Z'

test('noon of a day in a zone: Sydney in summer is UTC+11; UTC is itself', () => {
  assert.equal(noonIn('2026-11-12', 'Australia/Sydney').toISOString(), NOON_SYDNEY)
  assert.equal(noonIn('2026-06-12', 'Australia/Sydney').toISOString(), '2026-06-12T02:00:00.000Z')
  assert.equal(noonIn('2026-11-12', 'UTC').toISOString(), '2026-11-12T12:00:00.000Z')
})

test('a new entry with the mark enters sent: a manual initial row at noon in the zone, imported + sent events, no CV, no check', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const queue = queueDouble()
  const checks = checksSpy()
  const report = reportOf(await importSeed(db, context({ readText: await marked('2026-11-12'), enqueueCv: queue.enqueueCv, enqueueSeedChecks: checks.enqueueSeedChecks }), { dryRun: false }))
  const sent = app(db, `${WAVE1}#1`)
  assert.ok(sent)
  assert.equal(sent.state, 'sent')
  assert.deepEqual(
    sent.sends.map((s) => [s.kind, s.channel, s.messageId, s.state, s.at]),
    [['initial', 'manual', null, 'sent', NOON_SYDNEY]],
  )
  const events = db.read((q) => eventsOf(q, sent.id))
  assert.deepEqual(events.map((e) => e.kind), ['imported', 'sent'])
  assert.equal(events[1]?.at, NOON_SYDNEY)
  assert.equal(events[1]?.recordedAt, '2026-11-14T00:00:00.000Z')
  assert.deepEqual(events[1]?.data, { kind: 'initial', manual: true, byHand: true })
  assert.equal(db.read((q) => getArtifacts(q, sent.id, 1))?.origin, 'seed')
  assert.ok(!queue.cv.includes(sent.id))
  assert.ok(!checks.calls.flat().includes(sent.target.contactId ?? ''), 'no address check for a sent entry')
  assert.deepEqual(report.byHand, [{ file: WAVE1, n: 1, at: NOON_SYDNEY, result: 'sent' }])
  db.close()
})

test('an entry imported before and not sent (no row in sends) goes sent on the reimport, in its own transaction', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  reportOf(await importSeed(db, context(), { dryRun: false }))
  assert.equal(app(db, `${WAVE1}#1`)?.state, 'generating')
  const report = reportOf(await importSeed(db, context({ readText: await marked('2026-11-12') }), { dryRun: false }))
  const sent = app(db, `${WAVE1}#1`)
  assert.equal(sent?.state, 'sent')
  assert.equal(sent?.sends[0]?.at, NOON_SYDNEY)
  assert.deepEqual(db.read((q) => eventsOf(q, sent?.id ?? '')).map((e) => e.kind), ['imported', 'prepared', 'sent'])
  assert.deepEqual(report.byHand, [{ file: WAVE1, n: 1, at: NOON_SYDNEY, result: 'sent' }])
  db.close()
})

test('an entry that already has a row in sends is not touched, and the report says already-sent', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const readText = await marked('2026-11-12')
  reportOf(await importSeed(db, context({ readText }), { dryRun: false }))
  const events = count(db, 'events')
  const before = app(db, `${WAVE1}#1`)
  const again = reportOf(await importSeed(db, context({ readText: await marked('2026-11-13') }), { dryRun: false }))
  assert.deepEqual(app(db, `${WAVE1}#1`), before)
  assert.equal(count(db, 'events'), events)
  assert.deepEqual(again.byHand, [{ file: WAVE1, n: 1, at: '2026-11-13T01:00:00.000Z', result: 'already-sent' }])
  db.close()
})

test('a closed entry is not reopened by the mark: the report says closed', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  reportOf(await importSeed(db, context({ enqueueCv: () => ok(undefined) }), { dryRun: false }))
  db.tx((q) => ok(q.run("UPDATE applications SET state = 'closed', outcome = 'dropped' WHERE seed_key = ?", `${WAVE1}#1`)))
  const report = reportOf(await importSeed(db, context({ readText: await marked('2026-11-12') }), { dryRun: true }))
  assert.equal(report.byHand[0]?.result, 'closed')
  reportOf(await importSeed(db, context({ readText: await marked('2026-11-12') }), { dryRun: false }))
  assert.equal(app(db, `${WAVE1}#1`)?.state, 'closed')
  db.close()
})

for (const [why, day] of [
  ['a date that does not parse', '12/11/2026'],
  ['a day that does not exist', '2026-02-30'],
  ['a date in the future', '2026-11-15'],
] as const) {
  test(`${why}: the dry run marks it invalid and the real import answers invalid without writing anything`, async () => {
    using base = tempBase()
    const db = await storeWith(base)
    const readText = await marked(day)
    const dry = reportOf(await importSeed(db, context({ readText }), { dryRun: true }))
    assert.deepEqual(dry.byHand, [{ file: WAVE1, n: 1, at: null, result: 'invalid' }])
    const events = count(db, 'events')
    const real = await importSeed(db, context({ readText }), { dryRun: false })
    assert.deepEqual(real, { ok: false, error: { code: 'invalid', reason: 'sent-by-hand is not a past day, YYYY-MM-DD', field: `${WAVE1}#1` } })
    assert.equal(count(db, 'applications'), 0)
    assert.equal(count(db, 'events'), events)
    db.close()
  })
}

test('today in the zone is a valid day: at 00:30 in Sydney on the 14th, the 14th is not the future', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const dry = reportOf(await importSeed(db, context({ readText: await marked('2026-11-14'), now: () => new Date('2026-11-13T13:30:00.000Z') }), { dryRun: true }))
  assert.equal(dry.byHand[0]?.result, 'sent')
  db.close()
})

test('a sent entry older than the last read of the mailbox leaves meta.replyBackfillFrom, the earliest one', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  db.tx((q) => ok(setMeta(q, 'lastReplyPoll', '2026-11-13T00:00:00.000Z')))
  reportOf(await importSeed(db, context({ readText: await marked('2026-11-12') }), { dryRun: false }))
  assert.equal(db.read((q) => getMeta(q, 'replyBackfillFrom')), NOON_SYDNEY)

  using other = tempBase()
  const earlier = await storeWith(other)
  earlier.tx((q) => {
    setMeta(q, 'lastReplyPoll', '2026-11-13T00:00:00.000Z')
    setMeta(q, 'replyBackfillFrom', '2026-11-01T00:00:00.000Z')
    return ok(undefined)
  })
  reportOf(await importSeed(earlier, context({ readText: await marked('2026-11-12') }), { dryRun: false }))
  assert.equal(earlier.read((q) => getMeta(q, 'replyBackfillFrom')), '2026-11-01T00:00:00.000Z')
  earlier.close()

  using none = tempBase()
  const fresh = await storeWith(none)
  reportOf(await importSeed(fresh, context({ readText: await marked('2026-11-12') }), { dryRun: false }))
  assert.equal(fresh.read((q) => getMeta(q, 'replyBackfillFrom')), undefined, 'no poll yet: nothing to backfill')
  fresh.close()
  db.close()
})

test('the reimport of an existing entry also leaves replyBackfillFrom', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  reportOf(await importSeed(db, context(), { dryRun: false }))
  db.tx((q) => ok(setMeta(q, 'lastReplyPoll', '2026-11-13T00:00:00.000Z')))
  reportOf(await importSeed(db, context({ readText: await marked('2026-11-12') }), { dryRun: false }))
  assert.equal(db.read((q) => getMeta(q, 'replyBackfillFrom')), NOON_SYDNEY)
  db.close()
})

test('the report lists byHandPending: the entries of a byHand file that do not carry the mark yet', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const vault = vaultOf([{ file: ADS }, { file: WAVE1, byHand: true }, { file: WAVE2, holdUntil: HOLD }])
  const report = reportOf(await importSeed(db, context({ vault, readText: await marked('2026-11-12') }), { dryRun: true }))
  assert.deepEqual(report.byHandPending, [
    { file: WAVE1, n: 2, company: 'Lyrebird Labs' },
    { file: WAVE1, n: 3, company: 'Numbat Supply' },
    { file: WAVE1, n: 4, company: 'Quokka Systems' },
    { file: WAVE1, n: 5, company: 'Wombat Studio' },
    { file: WAVE1, n: 6, company: 'Echidna Cloud' },
  ])
  assert.equal(report.queued.cv, 7, 'the ads only: wave 1 is byHand')
  db.close()
})
