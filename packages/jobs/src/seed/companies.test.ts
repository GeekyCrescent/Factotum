import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { atsOf, nameKey, parseCompanies, parseHealthEmployers, scoreOf } from './companies.ts'

const RAW: unknown = JSON.parse(await readFile(new URL('../../test/fixtures/companies.json', import.meta.url), 'utf8'))
const HEALTH = parseHealthEmployers(
  JSON.parse(await readFile(new URL('../../assets/health-employers.json', import.meta.url), 'utf8')),
)
const seeded = parseCompanies(RAW, HEALTH)
const byKey = (key: string) => {
  const found = seeded.find((entry) => entry.company.nameKey === key)
  assert.ok(found, `no company ${key}`)
  return found
}

test('every company in the file becomes a company and an opportunity', () => {
  assert.equal(seeded.length, 5)
})

test('kind comes from opportunity_type, for the three types', () => {
  assert.equal(byKey('bluegum analytics').opportunity.kind, 'vacancy')
  assert.equal(byKey('wattle robotics').opportunity.kind, 'outreach')
  assert.equal(byKey('ironbark data').opportunity.kind, 'historical')
})

test('breakdown renames part_time to partTime and growth to hiring', () => {
  assert.deepEqual(byKey('bluegum analytics').opportunity.breakdown, {
    partTime: { score: 5, why: '' },
    skills: { score: 4, why: '' },
    hiring: { score: 3, why: '' },
    visa: { score: 4, why: '' },
    access: { score: 2, why: '' },
  })
})

test('score is build.py:59-60: sum of weight times score, over 5, times 100 (by hand: 78)', () => {
  // 0.30·5 + 0.25·4 + 0.20·3 + 0.15·4 + 0.10·2 = 1.5 + 1 + 0.6 + 0.6 + 0.2 = 3.9 → 3.9 / 5 · 100 = 78
  assert.equal(byKey('bluegum analytics').opportunity.score, 78)
  assert.equal(scoreOf({ part_time: 5, skills: 5, growth: 5, visa: 5, access: 5 }), 100)
  assert.equal(scoreOf({ part_time: 1, skills: 1, growth: 1, visa: 1, access: 1 }), 20)
})

test('contacts: one per recruiting contact, and one for an email in contact, all unverified', () => {
  assert.deepEqual(byKey('bluegum analytics').company.contacts, [
    { name: 'Pat Lee', role: 'CTO', email: null, sourceUrl: 'https://bluegum.example/about' },
    { name: 'Sam Ng', role: 'CEO & Co-founder (named on the about page)', email: null, sourceUrl: 'https://bluegum.example/about' },
  ])
  assert.deepEqual(byKey('wattle robotics').company.contacts, [
    { name: null, role: null, email: 'hello@wattle-robotics.example', sourceUrl: 'https://wattle-robotics.example/contact' },
  ])
  assert.deepEqual(byKey('ironbark data').company.contacts, [])
})

test('a company on the curated list is a health employer, curated', () => {
  const careGp = byKey('care gp').company
  assert.equal(careGp.isHealthEmployer, true)
  assert.equal(careGp.healthSource, 'curated')
})

test('"healthtech" in industry off the list only suggests: false and guessed (the Lorikeet case)', () => {
  const parrotfish = byKey('parrotfish').company
  assert.equal(parrotfish.isHealthEmployer, false)
  assert.equal(parrotfish.healthSource, 'guessed')
})

test('by default a company is not a health employer and has no health source', () => {
  const wattle = byKey('wattle robotics').company
  assert.equal(wattle.isHealthEmployer, false)
  assert.equal(wattle.healthSource, null)
})

test('the curated list is the owner-approved three, and Lorikeet is not on it', () => {
  assert.deepEqual(HEALTH, ['Dokotela', 'Care GP', 'Carebotics.ai'])
})

test('ATS from the host of application_url, else careers_url', () => {
  assert.deepEqual(byKey('bluegum analytics').company.ats, { kind: 'ashby', ref: 'bluegum' })
  assert.deepEqual(byKey('parrotfish').company.ats, { kind: 'greenhouse', ref: 'parrotfish' })
  assert.deepEqual(byKey('ironbark data').company.ats, { kind: 'bamboohr', ref: 'ironbark' })
  assert.equal(byKey('wattle robotics').company.ats, null)
})

test('atsOf knows each ATS by host, and a job board is not an ATS', () => {
  assert.deepEqual(atsOf('https://jobs.lever.co/acme/123'), { kind: 'lever', ref: 'acme' })
  assert.deepEqual(atsOf('https://job-boards.greenhouse.io/acme/jobs/1'), { kind: 'greenhouse', ref: 'acme' })
  assert.deepEqual(atsOf('https://apply.workable.com/acme/j/ABC/'), { kind: 'workable', ref: 'acme' })
  assert.deepEqual(atsOf('https://acme.wd105.myworkdayjobs.com/en-US/X/job/Y'), { kind: 'workday', ref: 'acme' })
  assert.deepEqual(atsOf('https://jobs.smartrecruiters.com/Acme/7440-x'), { kind: 'smartrecruiters', ref: 'Acme' })
  assert.deepEqual(atsOf('https://acme.breezy.hr/p/x'), { kind: 'breezy', ref: 'acme' })
  assert.deepEqual(atsOf('https://app.dover.com/apply/acme/uuid'), { kind: 'dover', ref: 'acme' })
  assert.deepEqual(atsOf('https://jobs.dover.com/acme'), { kind: 'dover', ref: 'acme' })
  assert.deepEqual(atsOf('https://ats.rippling.com/acme/jobs'), { kind: 'other', ref: 'ats.rippling.com' })
  assert.equal(atsOf('https://www.seek.com.au/job/1'), null)
  assert.equal(atsOf('not a url'), null)
  assert.equal(atsOf(null), null)
})

test('nameKey: lowercase, no accents, no parentheses, no company suffix, no punctuation', () => {
  assert.equal(nameKey('Bluegum Analytics Pty Ltd'), 'bluegum analytics')
  assert.equal(nameKey('Parrotfish (Parrotfish AI)'), 'parrotfish')
  assert.equal(nameKey('Ironbark Data Inc.'), 'ironbark data')
  assert.equal(nameKey('Café Ñandú Limited'), 'cafe nandu')
  assert.equal(nameKey('Mortgages & Leasing'), 'mortgages leasing')
  assert.equal(nameKey('Tern Labs (platform / freelance)'), 'tern labs')
})

test('record: the text of the fields that may carry figures, and only those', () => {
  const record = byKey('bluegum analytics').company.record
  for (const piece of ['11-50', 'Data analytics', 'Python, SQL', '3 retail clients', '13 rows down to 5', '12 days ago', '$38–42/h', '16–20 h/week', '30 staff']) {
    assert.ok(record.includes(piece), `record lacks ${piece}`)
  }
  assert.ok(!record.includes('Apply this week'), 'next_action is not a figure field')
  assert.equal(byKey('ironbark data').company.record, '')
})

test('company fields: domain from the website, size split from its source, sector and location', () => {
  const company = byKey('bluegum analytics').company
  assert.equal(company.name, 'Bluegum Analytics Pty Ltd')
  assert.equal(company.domain, 'bluegum.example')
  assert.equal(company.website, 'https://www.bluegum.example')
  assert.equal(company.careersUrl, 'https://bluegum.example/careers')
  assert.deepEqual(company.size, { value: '11-50', source: 'LinkedIn company data' })
  assert.deepEqual(byKey('parrotfish').company.size, { value: '51-200', source: '' })
  assert.equal(company.sector, 'Data analytics for retailers')
  assert.equal(company.location, 'Surry Hills, Sydney')
  assert.equal(byKey('ironbark data').company.domain, null)
})

test('opportunity fields: title, url, dates, salary and requirements', () => {
  const opportunity = byKey('bluegum analytics').opportunity
  assert.equal(opportunity.title, 'Graduate Data Engineer (part-time)')
  assert.equal(opportunity.url, 'https://jobs.ashbyhq.com/bluegum/0a1b2c3d-0000-4000-8000-000000000001')
  assert.equal(opportunity.closesAt, '2026-12-01')
  assert.equal(opportunity.startsAt, '2027-01-12')
  assert.equal(opportunity.salary, '$38–42/h')
  assert.equal(opportunity.requirements, 'Python, SQL, 1+ year of data pipelines.')
  assert.equal(byKey('wattle robotics').opportunity.requirements, '')
})

test('a file that is not the expected shape is refused with the entry that broke it', () => {
  assert.throws(() => parseCompanies({ not: 'a list' }, HEALTH), /companies/)
  assert.throws(() => parseCompanies([{ company: 'X' }], HEALTH), /companies\[0\]/)
  assert.throws(() => parseHealthEmployers({ names: 3 }), /health-employers/)
})
