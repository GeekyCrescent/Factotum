import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Artifacts, Warning } from '../types.ts'
import { lint, type LintContext } from './lint.ts'
import { numbersIn, unknownNumbers, type NumberSources } from './numbers.ts'
import { contactHashOf } from './render.ts'
import { ARTIFACTS, COMPANY, DOC, MASTER, OPPORTUNITY, PROFILE } from './test-cv.ts'

const SOURCES: NumberSources = { master: MASTER, profile: PROFILE, opportunity: OPPORTUNITY, company: COMPANY }

const CTX: LintContext = {
  master: MASTER,
  profile: PROFILE,
  opportunity: OPPORTUNITY,
  company: COMPANY,
  channel: 'email',
  to: 'jobs@contoso.test',
  pdfExists: true,
  letterPending: false,
}
const CLEAN: Artifacts = { ...ARTIFACTS, contactHash: contactHashOf(PROFILE) }
const unknown = (warnings: readonly Warning[]): readonly Warning[] => warnings.filter((w) => w.code === 'unknown-number')
const block = (where: Warning['where'], n: string): Warning => ({ code: 'unknown-number', where, detail: `number ${n} not in cv-maestro`, blocks: true, overridden: null })

test('numbersIn normalises: 1,069 is 1069, 6× is 6, 40% is 40, 03 is 3, 3.50 is 3.5', () => {
  assert.deepEqual(numbersIn('1,069 tests; 6× faster; 40% less; day 03; 3.50 h'), ['1069', '6', '40', '3', '3.5'])
})

test('numbersIn: dates and ranges give each of their numbers', () => {
  assert.deepEqual(numbersIn('Mar 2024 – Present, 16–20 h/week, 2026-02-05'), ['2024', '16', '20', '2026', '2', '5'])
})

test('numbersIn: a figure glued to a word is part of a name, not a number (EC2, HL7, COMP8300, v2)', () => {
  assert.deepEqual(numbersIn('EC2, HL7, COMP8300 and API v2; 10x and $18.9M'), ['10', '18.9'])
})

test('numbersIn: a sentence’s full stop or a thousands comma never makes a decimal or a second number', () => {
  assert.deepEqual(numbersIn('Shipped in 2024. Then 12,500 users, 3, 4 and 5.'), ['2024', '12500', '3', '4', '5'])
})

test('a CV whose every figure is in cv-maestro passes', () => {
  assert.deepEqual(unknown(lint(CLEAN, CTX)), [])
})

test('the master writes 1,069 and the CV 1069 (and the other way round): the same number', () => {
  const ctx = { ...CTX, master: 'Ran 1,069 tests and cut cost 6×.' }
  const artifacts: Artifacts = { ...CLEAN, cv: { ...DOC, summary: 'Ran 1069 tests; cut cost 6x.', experience: [], education: [] } }
  assert.deepEqual(unknown(lint(artifacts, ctx)), [])
})

test('a percentage or a range only partly in a source blocks on the part that is not', () => {
  const ctx = { ...CTX, master: 'Cut latency 40%. Teams of 16 to 20.' }
  const artifacts: Artifacts = { ...CLEAN, cv: { ...DOC, summary: 'Cut latency 45%, teams of 16–22.', experience: [], education: [] } }
  assert.deepEqual(unknown(lint(artifacts, ctx)), [block('cv', '45'), block('cv', '22')])
})

test('a figure that is only in the profile passes (the availability line, 16–20 h)', () => {
  const profile = { ...PROFILE, availability: 'Then 16–20 hours a week.' }
  const ctx = { ...CTX, profile }
  const artifacts: Artifacts = { ...CLEAN, contactHash: contactHashOf(profile), letter: { subject: null, body: 'I can do 16–20 hours. {signature}' } }
  assert.deepEqual(unknown(lint(artifacts, ctx)), [])
})

test('a figure that is only in the ad passes', () => {
  const ctx = { ...CTX, opportunity: { ...OPPORTUNITY, requirements: 'A 6-month contract, 3 days a week.' } }
  const artifacts: Artifacts = { ...CLEAN, letter: { subject: 'Your 6-month role', body: 'Three days, 3 a week, suits me. {signature}' } }
  assert.deepEqual(unknown(lint(artifacts, ctx)), [])
})

test('a figure only in the company record (employee_count) passes; in no source at all, it blocks', () => {
  const ctx = { ...CTX, company: { ...COMPANY, record: '1,500 employees (LinkedIn)\nFintech' } }
  const known: Artifacts = { ...CLEAN, letter: { subject: null, body: 'Your 1500 people move money. {signature}' } }
  assert.deepEqual(unknown(lint(known, ctx)), [])
  const invented: Artifacts = { ...CLEAN, letter: { subject: null, body: 'Your 1,700 people move money. {signature}' } }
  assert.deepEqual(unknown(lint(invented, ctx)), [block('letter', '1700')])
})

test('dates: a year of the CV that is in no source blocks, with its where', () => {
  const [role] = DOC.experience
  const artifacts: Artifacts = { ...CLEAN, cv: { ...DOC, experience: [{ ...role!, dates: 'Mar 2023 – Present' }] } }
  assert.deepEqual(unknown(lint(artifacts, CTX)), [block('cv', '2023')])
})

test('the subject is checked; a number repeated is named once; the sources of a bullet (§5.1) are never read', () => {
  const artifacts: Artifacts = { ...CLEAN, letter: { subject: 'Ref 77', body: 'Ref 77 and 77 again. {signature}' } }
  assert.deepEqual(unknown(lint(artifacts, CTX)), [block('subject', '77'), block('letter', '77')])
  const sources: Artifacts = { ...CLEAN, cv: { ...DOC, projects: [{ ...DOC.projects[0]!, source: '§9.9' }] } }
  assert.deepEqual(unknown(lint(sources, CTX)), [])
})

test('form answers and the LinkedIn note are not the CV or the letter: their figures are not checked', () => {
  const artifacts: Artifacts = { ...CLEAN, form: [{ question: 'Rate?', answer: 'A$88', ok: true, hint: null }], linkedin: 'Hi, 99 thanks' }
  assert.deepEqual(unknown(lint(artifacts, CTX)), [])
})

test('unknownNumbers lists the figures of a text that no source has, in order, once', () => {
  assert.deepEqual(unknownNumbers('13 and 40 and 13 and 7', SOURCES), ['13', '7'])
})
