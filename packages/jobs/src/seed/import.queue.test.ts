import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Db } from '../store/db.ts'
import { applicationBySeedKey, eventsOf, getContact } from '../store/repo.ts'
import { tempBase } from '../test-support.ts'
import { ok } from '../types.ts'
import { importSeed, type ImportReport } from './import.ts'
import { ADS, checksSpy, context, COUNTS, HOLD, queueDouble, storeWith, vaultOf, WAVE1, WAVE2 } from './test-seed.ts'

// tasks S6: after the tx, the CV of every application the module will send is queued (G2a, injected),
// and the addresses of those applications go to the checks (N4, injected).

function reportOf(result: Awaited<ReturnType<typeof importSeed>>): ImportReport {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.reason}`)
  return result.value
}

const stateOf = (db: Db, seedKey: string) => db.read((q) => applicationBySeedKey(q, seedKey)?.state)
const genRequests = (db: Db): readonly string[] =>
  db.read((q) => q.all<{ entity_id: string }>("SELECT entity_id FROM gen_requests WHERE kind = 'cv' ORDER BY rowid").map((row) => row.entity_id))
const emailsOf = (db: Db, ids: readonly string[]): readonly (string | null)[] => db.read((q) => ids.map((id) => getContact(q, id)?.email ?? null))

const SENT_BY_MODULE = COUNTS[ADS] + COUNTS[WAVE1]

test('with the default config the CVs of the ads and of wave 1 are queued; wave 2 stays draft until its holdUntil', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const queue = queueDouble()
  const report = reportOf(await importSeed(db, context({ enqueueCv: queue.enqueueCv }), { dryRun: false }))
  assert.equal(queue.cv.length, SENT_BY_MODULE)
  assert.equal(report.queued.cv, SENT_BY_MODULE)
  assert.deepEqual(genRequests(db), queue.cv)
  assert.equal(stateOf(db, `${ADS}#1`), 'generating')
  assert.equal(stateOf(db, `${WAVE1}#6`), 'generating')
  for (let n = 1; n <= COUNTS[WAVE2]; n += 1) assert.equal(stateOf(db, `${WAVE2}#${n}`), 'draft')
  const ad = db.read((q) => applicationBySeedKey(q, `${ADS}#1`))
  assert.deepEqual(db.read((q) => eventsOf(q, ad?.id ?? '')).map((e) => e.kind), ['imported', 'prepared'])
  db.close()
})

test('a byHand file queues no CV and no address check for its entries; the other files still do', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const queue = queueDouble()
  const checks = checksSpy()
  const vault = vaultOf([{ file: ADS, byHand: true }, { file: WAVE1 }, { file: WAVE2, holdUntil: HOLD }])
  const report = reportOf(await importSeed(db, context({ vault, enqueueCv: queue.enqueueCv, enqueueSeedChecks: checks.enqueueSeedChecks }), { dryRun: false }))
  assert.equal(queue.cv.length, COUNTS[WAVE1])
  for (let n = 1; n <= COUNTS[ADS]; n += 1) assert.equal(stateOf(db, `${ADS}#${n}`), 'draft')
  const checked = emailsOf(db, checks.calls.flat())
  for (const email of ['hr@petrel.example', 'careers@ironbark.example']) assert.ok(!checked.includes(email), `${email} is of a byHand file`)
  assert.ok(checked.includes('hr@kookaburra.example'))
  assert.equal(report.queued.cv, COUNTS[WAVE1])
  db.close()
})

test('the checks hook is called once, after the tx, with exactly the addresses of what the module will send: ads and wave 1 first, wave 2 behind', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const checks = checksSpy()
  const report = reportOf(await importSeed(db, context({ enqueueSeedChecks: checks.enqueueSeedChecks }), { dryRun: false }))
  assert.equal(checks.calls.length, 1)
  assert.deepEqual(emailsOf(db, checks.calls[0] ?? []), [
    'hr@petrel.example',
    'careers@ironbark.example',
    'hr@kookaburra.example',
    'info@lyrebird.example',
    'info@echidna.example',
    'business@possum.example',
    'careers@galah.example',
    'hello@dingo.example',
    'hello@emu.example',
    'info@bilby.example',
    'contact@quoll.example',
    'hello@cockatoo.example',
    'hello@cassowary.example',
    'support@platypus.example',
  ])
  assert.equal(report.queued.checks, 14)
  db.close()
})

test('a second import queues nothing again and calls the checks hook with nothing', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  reportOf(await importSeed(db, context(), { dryRun: false }))
  const queue = queueDouble()
  const checks = checksSpy()
  const second = reportOf(await importSeed(db, context({ enqueueCv: queue.enqueueCv, enqueueSeedChecks: checks.enqueueSeedChecks }), { dryRun: false }))
  assert.deepEqual(queue.cv, [])
  assert.deepEqual(checks.calls, [])
  assert.deepEqual(second.queued, { cv: 0, checks: 0 })
  db.close()
})

test('a CV the queue refuses leaves its application draft, says so in the report, and the rest are queued', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const refused = new Set<string>()
  const queue = queueDouble((id) => {
    if (refused.size === 0) refused.add(id)
    return refused.has(id)
  })
  const report = reportOf(await importSeed(db, context({ enqueueCv: queue.enqueueCv }), { dryRun: false }))
  assert.equal(queue.cv.length, SENT_BY_MODULE - 1)
  assert.equal(report.queued.cv, SENT_BY_MODULE - 1)
  assert.equal(stateOf(db, `${ADS}#1`), 'draft')
  assert.deepEqual(report.warnings, [`${ADS}#1: the CV was not queued (module-error: the queue refused)`])
  db.close()
})

// ── Review fix: what to queue comes from the state, so a re-import repairs a lost CV ─────────────────

test('a CV the queue refused is queued by the next import, and the failure is logged', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const errors: string[] = []
  const log = { info: () => {}, warn: () => {}, error: (message: string) => void errors.push(message) }
  const first = reportOf(await importSeed(db, context({ enqueueCv: queueDouble((id) => id === db.read((q) => applicationBySeedKey(q, `${ADS}#1`)?.id)).enqueueCv, log }), { dryRun: false }))
  assert.equal(first.queued.cv, SENT_BY_MODULE - 1)
  assert.deepEqual(errors, [`seed: ${ADS}#1: the CV was not queued (module-error: the queue refused)`])
  const queue = queueDouble()
  const second = reportOf(await importSeed(db, context({ enqueueCv: queue.enqueueCv }), { dryRun: false }))
  assert.equal(second.queued.cv, 1)
  assert.deepEqual(queue.cv, [db.read((q) => applicationBySeedKey(q, `${ADS}#1`)?.id)])
  assert.equal(stateOf(db, `${ADS}#1`), 'generating')
  db.close()
})

test('a draft left with no CV request (a crash after the tx) is queued by the next import; the dry run counts it', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  reportOf(await importSeed(db, context({ enqueueCv: () => ok(undefined) }), { dryRun: false }))
  assert.equal(genRequests(db).length, 0)
  const dry = reportOf(await importSeed(db, context(), { dryRun: true }))
  assert.equal(dry.queued.cv, SENT_BY_MODULE)
  const queue = queueDouble()
  const report = reportOf(await importSeed(db, context({ enqueueCv: queue.enqueueCv }), { dryRun: false }))
  assert.equal(report.queued.cv, SENT_BY_MODULE)
  assert.deepEqual(genRequests(db), queue.cv)
  db.close()
})

test('wave 2 is queued by an import once holdUntil − 7 days has come in jobs.timeZone, not the day before', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const dayBefore = new Date('2027-01-04T12:00:00.000Z') // 4 Jan, 23:00 in Sydney
  const early = reportOf(await importSeed(db, context({ now: () => dayBefore }), { dryRun: false }))
  assert.equal(early.queued.cv, SENT_BY_MODULE)
  const due = new Date('2027-01-04T13:00:00.000Z') // 5 Jan, 00:00 in Sydney = 12 Jan − 7 d
  const dry = reportOf(await importSeed(db, context({ now: () => due }), { dryRun: true }))
  assert.equal(dry.queued.cv, COUNTS[WAVE2])
  const queue = queueDouble()
  const report = reportOf(await importSeed(db, context({ now: () => due, enqueueCv: queue.enqueueCv }), { dryRun: false }))
  assert.equal(report.queued.cv, COUNTS[WAVE2])
  for (let n = 1; n <= COUNTS[WAVE2]; n += 1) assert.equal(stateOf(db, `${WAVE2}#${n}`), 'generating')
  db.close()
})

test('a checks hook that throws is a warning and a log line: the import still answers and the CVs are still queued', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const errors: string[] = []
  const log = { info: () => {}, warn: () => {}, error: (message: string) => void errors.push(message) }
  const queue = queueDouble()
  const enqueueSeedChecks = (): number => {
    throw new Error('the checks queue is down')
  }
  const report = reportOf(await importSeed(db, context({ enqueueCv: queue.enqueueCv, enqueueSeedChecks, log }), { dryRun: false }))
  assert.equal(report.queued.cv, SENT_BY_MODULE)
  assert.equal(report.queued.checks, 0)
  assert.deepEqual(report.warnings, ['the address checks were not queued (the checks queue is down)'])
  assert.deepEqual(errors, ['seed: the address checks were not queued (the checks queue is down)'])
  db.close()
})

test('the report counts the checks the hook says it queued, not the contacts it was given', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const report = reportOf(await importSeed(db, context({ enqueueSeedChecks: () => 3 }), { dryRun: false }))
  assert.equal(report.queued.checks, 3)
  db.close()
  using other = tempBase()
  const without = await storeWith(other)
  const none = reportOf(await importSeed(without, context(), { dryRun: false }))
  assert.equal(none.queued.checks, 0, 'no hook, nothing queued')
  without.close()
})

test('the dry run queues nothing and calls no hook, but says what it would queue', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const queue = queueDouble()
  const checks = checksSpy()
  const report = reportOf(await importSeed(db, context({ enqueueCv: queue.enqueueCv, enqueueSeedChecks: checks.enqueueSeedChecks }), { dryRun: true }))
  assert.deepEqual(queue.cv, [])
  assert.deepEqual(checks.calls, [])
  assert.deepEqual(report.queued, { cv: SENT_BY_MODULE, checks: 14 })
  db.close()
})
