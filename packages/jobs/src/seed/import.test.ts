import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDb } from '../store/db.ts'
import { applicationBySeedKey, companyByNameKey, eventsOf, getArtifacts, opportunityIdByDedupeKey } from '../store/repo.ts'
import { tempBase } from '../test-support.ts'
import { ok } from '../types.ts'
import { importSeed, type ImportReport } from './import.ts'
import { ADS, context, count, COUNTS, fixture, HOLD, NOW, readerWith, seedProfile, storeWith, vaultOf, WAVE1, WAVE2 } from './test-seed.ts'

const TOTAL = COUNTS[ADS] + COUNTS[WAVE1] + COUNTS[WAVE2]

function reportOf(result: Awaited<ReturnType<typeof importSeed>>): ImportReport {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.reason}`)
  return result.value
}

test('the dry run gives the report and writes nothing', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const events = count(db, 'events')
  const report = reportOf(await importSeed(db, context(), { dryRun: true }))
  assert.equal(report.dryRun, true)
  assert.equal(report.blocked, null)
  assert.deepEqual(
    report.files.map((f) => [f.file, f.entries, f.new, f.existing]),
    [
      [ADS, 7, 7, 0],
      [WAVE1, 6, 6, 0],
      [WAVE2, 9, 9, 0],
    ],
  )
  assert.deepEqual(report.files[0]?.channels, { email: 1, form: 5, platform: 1, linkedin: 0 })
  assert.equal(report.companies.read, 5)
  for (const table of ['companies', 'contacts', 'opportunities', 'applications', 'artifacts']) assert.equal(count(db, table), 0, table)
  assert.equal(count(db, 'events'), events)
  db.close()
})

test('the real import: one draft per entry, version 1 from the seed, no lint, its seed key, holdUntil and one imported event', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  // The queue (S6) is a no-op here: what is checked is what the import's tx wrote.
  const report = reportOf(await importSeed(db, context({ enqueueCv: () => ok(undefined) }), { dryRun: false }))
  assert.equal(report.dryRun, false)
  assert.equal(count(db, 'applications'), TOTAL)
  db.read((q) => {
    const ad = applicationBySeedKey(q, `${ADS}#1`)
    assert.ok(ad)
    assert.equal(ad.state, 'draft')
    assert.equal(ad.version, 1)
    assert.deepEqual(ad.warnings, [])
    assert.equal(ad.holdUntil, null)
    assert.equal(ad.channel, 'platform')
    assert.equal(ad.cvBase, 'B')
    assert.deepEqual(eventsOf(q, ad.id).map((e) => e.kind), ['imported'])
    const artifacts = getArtifacts(q, ad.id, 1)
    assert.equal(artifacts?.origin, 'seed')
    assert.equal(artifacts?.cv, null)
    assert.equal(artifacts?.profileVersion, 1)
    assert.match(artifacts?.letter?.body ?? '', /\{signature\}$/)
    assert.ok(artifacts?.form.some((f) => f.question === 'Right to work in Australia?' && f.answer.startsWith('Yes. I hold')))
    assert.equal(applicationBySeedKey(q, `${WAVE2}#1`)?.holdUntil, HOLD)
    assert.equal(applicationBySeedKey(q, `${WAVE1}#1`)?.holdUntil, null)
  })
  db.close()
})

test('an entry is matched to its company by nameKey and gets that company\'s opportunity', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  reportOf(await importSeed(db, context(), { dryRun: false }))
  db.read((q) => {
    const bluegum = companyByNameKey(q, 'bluegum analytics')
    assert.ok(bluegum)
    assert.equal(bluegum.name, 'Bluegum Analytics Pty Ltd')
    const app = applicationBySeedKey(q, `${ADS}#2`)
    assert.equal(app?.companyId, bluegum.id)
    assert.equal(app?.opportunityId, opportunityIdByDedupeKey(q, 'seed:bluegum analytics'))
  })
  db.close()
})

test('an entry without a company creates one with that name and says so in the report', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const report = reportOf(await importSeed(db, context(), { dryRun: false }))
  assert.ok(report.unmatched.some((u) => u.file === ADS && u.n === 1 && u.company === 'Kestrel Freight'))
  assert.ok(!report.unmatched.some((u) => u.file === ADS && u.n === 2), 'Bluegum is in the companies file')
  db.read((q) => {
    const kestrel = companyByNameKey(q, 'kestrel freight')
    assert.equal(kestrel?.name, 'Kestrel Freight')
    assert.equal(applicationBySeedKey(q, `${ADS}#1`)?.companyId, kestrel?.id)
    assert.equal(companyByNameKey(q, 'tern labs')?.name, 'Tern Labs', 'the parenthesis of the heading is not part of the name')
  })
  db.close()
})

test('the address of an email entry goes to a contact: unverified, or verified with the website when seen with a date', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const report = reportOf(await importSeed(db, context(), { dryRun: false }))
  db.read((q) => {
    const kookaburra = applicationBySeedKey(q, `${WAVE1}#1`)
    assert.equal(kookaburra?.target.to, 'hr@kookaburra.example')
    const contact = companyByNameKey(q, 'kookaburra legal')?.contacts.find((c) => c.id === kookaburra?.target.contactId)
    assert.equal(contact?.email, 'hr@kookaburra.example')
    assert.deepEqual(contact?.address, { status: 'unverified', verifiedUrl: null, checkedAt: null, override: null })
    const emu = companyByNameKey(q, 'emu vision')?.contacts.find((c) => c.email === 'hello@emu.example')
    assert.equal(emu?.address?.status, 'verified')
    assert.equal(emu?.address?.verifiedUrl, 'https://emu.example', 'no website in the companies file: the address\'s own domain')
    assert.equal(emu?.address?.checkedAt, null)
  })
  assert.ok(report.verified.some((v) => v.file === WAVE2 && v.email === 'hello@emu.example'))
  db.close()
})

test('two imports do not duplicate: the second finds every entry and company already there', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  reportOf(await importSeed(db, context(), { dryRun: false }))
  const tables = ['companies', 'contacts', 'opportunities', 'applications', 'artifacts', 'events'].map((t) => count(db, t))
  const second = reportOf(await importSeed(db, context(), { dryRun: false }))
  assert.deepEqual(['companies', 'contacts', 'opportunities', 'applications', 'artifacts', 'events'].map((t) => count(db, t)), tables)
  assert.deepEqual(second.files.map((f) => [f.new, f.existing]), [
    [0, 7],
    [0, 6],
    [0, 9],
  ])
  assert.equal(second.companies.created, 0)
  db.close()
})

test('without identity.phone the real import refuses and writes nothing; the dry run still reports, with missing-phone on top', async () => {
  using base = tempBase()
  const db = await storeWith(base, seedProfile({ phone: '' }))
  const events = count(db, 'events')
  const real = await importSeed(db, context(), { dryRun: false })
  assert.deepEqual(real, { ok: false, error: { code: 'blocked', reason: 'missing-phone' } })
  for (const table of ['companies', 'applications']) assert.equal(count(db, table), 0)
  assert.equal(count(db, 'events'), events)
  const dry = reportOf(await importSeed(db, context(), { dryRun: true }))
  assert.equal(dry.blocked, 'missing-phone')
  assert.equal(dry.files.length, 3)
  db.close()
})

test('without any profile the real import refuses too, saying missing-profile rather than missing-phone', async () => {
  using base = tempBase()
  const opened = await openDb({ dir: base.dir, now: () => NOW })
  assert.ok(opened.ok)
  const real = await importSeed(opened.value, context(), { dryRun: false })
  assert.deepEqual(real, { ok: false, error: { code: 'blocked', reason: 'missing-profile' } })
  const dry = reportOf(await importSeed(opened.value, context(), { dryRun: true }))
  assert.equal(dry.blocked, 'missing-profile')
  opened.value.close()
})

test('a failure halfway rolls the whole import back: two entries with the same N', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const doubled = (await fixture(WAVE1)).replace('## 2. Lyrebird Labs', '## 1. Lyrebird Labs')
  const result = await importSeed(db, context({ readText: readerWith({ [WAVE1]: doubled }) }), { dryRun: false })
  assert.equal(result.ok, false)
  for (const table of ['companies', 'contacts', 'opportunities', 'applications', 'artifacts']) assert.equal(count(db, table), 0, table)
  db.close()
})

test('a file that does not read, or a companies file of the wrong shape, is a module-error naming the path', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const missing = await importSeed(db, context({ vault: { ...vaultOf(), seed: { ...vaultOf().seed, kit: 'nope.md' } } }), { dryRun: true })
  assert.deepEqual(missing, { ok: false, error: { code: 'module-error', reason: 'seed: cannot read nope.md (ENOENT)' } })
  const denied = Object.assign(new Error('EACCES: permission denied, open /secret/path'), { code: 'EACCES' })
  const refused = await importSeed(db, context({ readText: () => Promise.reject(denied) }), { dryRun: true })
  assert.deepEqual(refused, { ok: false, error: { code: 'module-error', reason: 'seed: cannot read companies.json (EACCES)' } })
  const bad = await importSeed(db, context({ readText: readerWith({ 'companies.json': '{"not":"a list"}' }) }), { dryRun: true })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.error.reason, /^seed: companies\.json: /)
  const notJson = await importSeed(db, context({ readText: readerWith({ 'companies.json': 'nope' }) }), { dryRun: true })
  assert.equal(notJson.ok, false)
  db.close()
})

test('the report: missing fields, placeholders, skills, kit cites, kit leftovers, suggested health employers', async () => {
  using base = tempBase()
  const db = await storeWith(base)
  const report = reportOf(await importSeed(db, context(), { dryRun: true }))
  assert.ok(report.placeholders.some((p) => p.file === ADS && p.n === 6 && p.where === 'to'))
  assert.ok(report.skills.length > 0 && report.skills.every((s) => s.file === ADS))
  assert.ok(report.kitRefs.some((r) => r.file === ADS && r.n === 1 && r.section === 2 && r.matched !== null))
  assert.ok(Array.isArray(report.missing))
  assert.ok(Array.isArray(report.kit.leftovers))
  assert.ok(Array.isArray(report.kit.templateWarnings))
  assert.ok(report.companies.suggestedHealth.every((name) => typeof name === 'string'))
  db.close()
})
