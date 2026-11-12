import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Db } from '../store/db.ts'
import { applicationBySeedKey, eventsOf, getContact } from '../store/repo.ts'
import { tempBase } from '../test-support.ts'
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
