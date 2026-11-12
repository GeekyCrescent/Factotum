import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { fillSlots } from '../build/slots.ts'
import { tempBase } from '../test-support.ts'
import { importSeed, type ImportReport, type SeedVault } from './import.ts'
import { bracketTokens } from './markdown.ts'
import { readSeed } from './source.ts'
import { context, queueDouble, seedProfile, storeWith } from './test-seed.ts'

// tasks S7: the dry run over the REAL vault, on the owner's Mac. READ ONLY: the store is a temp one,
// and the vault's files are checked unchanged after. SKIPPED unless JOBS_VAULT_ROOT points at the
// vault (`JOBS_VAULT_ROOT=~/Ferro/Obsidian/Personal`), so CI never reads it.

const RAW_ROOT = process.env.JOBS_VAULT_ROOT
const ROOT = RAW_ROOT?.startsWith('~/') ? join(homedir(), RAW_ROOT.slice(2)) : RAW_ROOT
const skip = ROOT === undefined || ROOT === '' ? 'JOBS_VAULT_ROOT is not set: the real vault is only read on demand' : false

const PACKAGE = '03-life/carrera/postulaciones/paquete-2027'
const ADS = '02-postulaciones-anuncios.md'
const WAVE1 = '03-emails-ola-1.md'
const WAVE2 = '04-emails-ola-2.md'

/** design D13, the config of `jobs.vault.seed`, relative to the root. */
const VAULT: SeedVault = {
  root: ROOT ?? '',
  seed: {
    companies: '03-life/carrera/postulaciones/datos/empresas-2026-11-10.json',
    kit: `${PACKAGE}/00-kit-base.md`,
    cvs: `${PACKAGE}/01-cvs.md`,
    packages: [{ file: `${PACKAGE}/${ADS}` }, { file: `${PACKAGE}/${WAVE1}` }, { file: `${PACKAGE}/${WAVE2}`, holdUntil: '2027-01-12' }],
  },
}

const FILES = [VAULT.seed.companies, VAULT.seed.kit, VAULT.seed.cvs, ...VAULT.seed.packages.map((p) => p.file)]
const stamps = (): readonly string[] => FILES.map((file) => `${file} ${statSync(join(VAULT.root, file)).mtimeMs}`)

/** suburb, timezone and rate set: the slots of the kit all fill (R12). */
const PROFILE = (() => {
  const seeded = seedProfile({ suburb: 'Ryde', timezone: 'UTC+11 / Sydney' })
  return { ...seeded, preferences: { ...seeded.preferences, rateExpectation: 'A$40 per hour' } }
})()

const show = (t: TestContext, label: string, value: unknown): void => t.diagnostic(`${label}: ${JSON.stringify(value)}`)

function reportOf(result: Awaited<ReturnType<typeof importSeed>>): ImportReport {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.reason}`)
  return result.value
}

test('the real dry run: 100 / 18 / 25 / 37 and the channels per file', { skip }, async (t) => {
  using base = tempBase()
  const db = await storeWith(base, PROFILE)
  const before = stamps()
  const report = reportOf(await importSeed(db, context({ vault: VAULT, timeZone: 'Australia/Sydney' }), { dryRun: true }))
  assert.deepEqual(stamps(), before, 'the vault is not written')
  assert.equal(report.companies.read, 100)
  assert.deepEqual(
    report.files.map((f) => [f.file, f.entries]),
    [
      [ADS, 18],
      [WAVE1, 25],
      [WAVE2, 37],
    ],
  )
  const channels = Object.fromEntries(report.files.map((f) => [f.file, f.channels]))
  assert.deepEqual(channels[ADS], { email: 1, form: 12, platform: 5, linkedin: 0 })
  assert.deepEqual(channels[WAVE1], { email: 12, form: 8, platform: 0, linkedin: 5 })
  assert.deepEqual(channels[WAVE2], { email: 11, form: 17, platform: 0, linkedin: 9 })
  assert.equal(report.unmatched.length, 0, 'the 80 entries match a company')
  assert.deepEqual(report.queued, { cv: 43, checks: report.queued.checks })
  assert.deepEqual(report.byHand, [])

  show(t, 'channels', channels)
  show(t, 'missing', report.missing)
  show(t, 'placeholders', report.placeholders)
  show(t, 'skills', report.skills)
  show(t, 'kitRefs', report.kitRefs.map((r) => `${r.file}#${r.n} §${r.section} ${r.question} → ${r.matched}${r.ambiguous ? ' (ambiguous)' : ''}`))
  show(t, 'verified', report.verified.map((v) => `${v.file}#${v.n} ${v.email}`))
  show(t, 'kit', report.kit)
  show(t, 'suggestedHealth', report.companies.suggestedHealth)
  show(t, 'queued', report.queued)
  db.close()
})

test('the real kit: the 14 cites to §2 of the ads (and every other) resolve, and zero [...] after fillSlots', { skip }, async (t) => {
  const seed = await readSeed({ vault: VAULT })
  if (!seed.ok) assert.fail(seed.error.reason)
  const ads = seed.value.packages.find((p) => p.name === ADS)
  assert.ok(ads)
  // 14 cites to §2: those that ARE the answer are replaced by the kit's; one sits inside a written
  // answer («Right to work in Malaysia?»), which stays, its fragment lifted to `hint` (design D8 step 2).
  const replaced = ads.parsed.entries.flatMap((e) => e.kitRefs.filter((r) => r.section === 2))
  const embedded = ads.parsed.entries.flatMap((e) => e.form.filter((f) => /§\s*2\b/.test(f.hint ?? '') && !e.kitRefs.some((r) => r.question === f.question)))
  show(t, '§2 cites', { replaced: replaced.length, embedded: embedded.map((f) => f.question) })
  assert.equal(replaced.length + embedded.length, 14)
  assert.ok(embedded.every((f) => !/§/.test(f.answer)), 'the written answer keeps no cite')
  const cited = seed.value.packages.flatMap((p) =>
    p.parsed.entries.flatMap((e) => e.kitRefs.map((r) => ({ key: `${p.name}#${e.n}`, ref: r, answer: e.form.find((f) => f.question === r.question)?.answer ?? '' }))),
  )
  assert.ok(cited.every(({ ref }) => ref.matched !== null), 'every cite finds its question')
  const left = cited.flatMap(({ key, ref, answer }) => {
    const { text, missing } = fillSlots(answer, PROFILE)
    return [...bracketTokens(text), ...missing].map((token) => `${key} «${ref.question}»: ${token}`)
  })
  show(t, 'cites', cited.length)
  assert.deepEqual(left, [])
})

test('a real import into a temp store: 80 applications, 43 CVs queued (18 ads + 25 of wave 1), wave 2 draft', { skip }, async (t) => {
  using base = tempBase()
  const db = await storeWith(base, PROFILE)
  const before = stamps()
  const queue = queueDouble()
  const report = reportOf(await importSeed(db, context({ vault: VAULT, timeZone: 'Australia/Sydney', enqueueCv: queue.enqueueCv }), { dryRun: false }))
  assert.deepEqual(stamps(), before, 'the vault is not written')
  assert.equal(db.read((q) => q.get<{ n: number }>('SELECT count(*) AS n FROM applications')?.n), 80)
  assert.equal(queue.cv.length, 43)
  assert.equal(db.read((q) => q.get<{ n: number }>("SELECT count(*) AS n FROM applications WHERE state = 'draft'")?.n), 37)
  assert.deepEqual(report.warnings, [])
  show(t, 'checks queued', report.queued.checks)
  db.close()
})
