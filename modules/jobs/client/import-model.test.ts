import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ImportReport } from './contract.ts'
import { canImport, importFailureOf, reportOf } from './import-model.ts'

const report = (over: Partial<ImportReport> = {}): ImportReport => ({
  dryRun: true,
  blocked: null,
  companies: { read: 100, created: 2, suggestedHealth: [] },
  files: [{ file: '03-emails-ola-1.md', entries: 25, channels: { email: 12, form: 8, platform: 0, linkedin: 5 }, new: 25, existing: 0, holdUntil: null, byHand: false }],
  missing: [],
  unmatched: [],
  placeholders: [],
  kitRefs: [],
  verified: [],
  issues: [],
  byHand: [],
  byHandPending: [],
  queued: { cv: 43, checks: 12 },
  warnings: [],
  ...over,
})

test('the dry run reads as companies, each file with its channels, and what would be queued', () => {
  const view = reportOf(report())
  assert.equal(view.blocked, null)
  assert.deepEqual(view.lines, [
    '100 companies, 2 new',
    '03-emails-ola-1.md: 25 entries, 25 new · email 12 · form 8 · linkedin 5',
    'Would queue 43 CVs and 12 address checks',
  ])
  assert.deepEqual(view.sections, [])
})

test('the real import says what it queued, and a held or by-hand file says so', () => {
  const view = reportOf(
    report({
      dryRun: false,
      files: [{ file: '04.md', entries: 37, channels: { email: 37, form: 0, platform: 0, linkedin: 0 }, new: 0, existing: 37, holdUntil: '2027-01-12', byHand: true }],
    }),
  )
  assert.deepEqual(view.lines.slice(1), ['04.md: 37 entries, 37 already in · email 37 · held until 2027-01-12 · by hand', 'Queued 43 CVs and 12 address checks'])
})

test('without a phone the report says so on top, and the real import is not offered', () => {
  const view = reportOf(report({ blocked: 'missing-phone' }))
  assert.equal(view.blocked, 'Add your phone first: without it no CV of the package is printed.')
  assert.equal(canImport(report({ blocked: 'missing-phone' })), false)
  assert.equal(canImport(report()), true)
  assert.equal(canImport(report({ dryRun: false })), false, 'only after a dry run')
})

test('what needs a look is listed by kind, each entry by file and number', () => {
  const view = reportOf(
    report({
      missing: [{ file: 'a.md', n: 3, missing: ['subject'] }],
      unmatched: [{ file: 'a.md', n: 4, company: 'Newco' }],
      placeholders: [{ file: 'a.md', n: 5, where: 'letter', token: '[Name]' }],
      kitRefs: [
        { file: 'a.md', n: 6, question: 'Bio?', section: 2, matched: 'the bio', ambiguous: true },
        { file: 'a.md', n: 7, question: 'Rights?', section: 1, matched: 'rights', ambiguous: false },
      ],
      verified: [{ file: 'b.md', n: 1, email: 'hi@x.io', evidence: 'seen on the site 10 Nov 2026' }],
      issues: [{ kind: 'bad-date', file: 'b.md', n: null, detail: 'no date' }],
      byHand: [{ file: 'b.md', n: 2, at: '2026-11-10T01:00:00Z', result: 'sent' }],
      byHandPending: [{ file: 'b.md', n: 3, company: 'Acme' }],
      companies: { read: 1, created: 0, suggestedHealth: ['Lorikeet'] },
      warnings: ['the queue refused a CV'],
    }),
  )
  assert.deepEqual(
    view.sections.map((s) => [s.title, s.items]),
    [
      ['Fields not read', ['a.md #3: subject']],
      ['No company in the list (one is made)', ['a.md #4: Newco']],
      ['Placeholders left', ['a.md #5 letter: [Name]']],
      ['Kit answers matched loosely', ['a.md #6 «Bio?» → §2 the bio']],
      ['Addresses taken as verified', ['b.md #1: hi@x.io (seen on the site 10 Nov 2026)']],
      ['Suggested health employers (not switched on)', ['Lorikeet']],
      ['Sent by hand', ['b.md #2: sent']],
      ['Not sent by hand yet', ['b.md #3: Acme']],
      ['Issues', ['b.md: bad-date, no date']],
      ['Warnings', ['the queue refused a CV']],
    ],
  )
})

const refused = (status: number, message: string) => Object.assign(new Error(message), { status, body: { error: { code: 'blocked', message } } })

test('a refused import is read by its code: the phone with the way to it, the profile with its own words', () => {
  assert.deepEqual(importFailureOf(refused(422, 'missing-phone')), { text: 'Add your phone first: without it no CV of the package is printed.', toPhone: true })
  assert.deepEqual(importFailureOf(refused(422, 'missing-profile')), { text: 'There is no profile yet: save the settings first.', toPhone: false })
  assert.deepEqual(importFailureOf(refused(500, 'the vault is not there')), { text: 'the vault is not there', toPhone: false })
  assert.deepEqual(importFailureOf(new Error('Add your phone, says a proxy')), { text: 'Add your phone, says a proxy', toPhone: false }, 'never by the text')
})
