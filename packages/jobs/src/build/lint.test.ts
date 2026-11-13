import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Artifacts, Profile, Warning, WarningCode } from '../types.ts'
import { lint, lintFollowup, type LintContext } from './lint.ts'
import { contactHashOf } from './render.ts'
import { matchTerm } from './terms.ts'
import { ARTIFACTS, COMPANY, DOC, MASTER, OPPORTUNITY, PROFILE } from './test-cv.ts'

/** A clean application: printed with today's contact, its PDF on disk, nothing to say. */
const CLEAN: Artifacts = { ...ARTIFACTS, contactHash: contactHashOf(PROFILE) }

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

const withIdentity = (identity: Partial<Profile['identity']>): Profile => ({ ...PROFILE, identity: { ...PROFILE.identity, ...identity } })
const letter = (body: string, subject: string | null = 'Application'): Artifacts => ({ ...CLEAN, letter: { subject, body } })
const cv = (over: Partial<typeof DOC>): Artifacts => ({ ...CLEAN, cv: { ...DOC, ...over } })
const codes = (warnings: readonly Warning[]): readonly WarningCode[] => warnings.map((w) => w.code)
const only = (warnings: readonly Warning[], code: WarningCode): readonly Warning[] => warnings.filter((w) => w.code === code)
const block = (code: WarningCode, where: Warning['where'], detail: string): Warning => ({ code, where, detail, blocks: true, overridden: null })
const notice = (code: WarningCode, where: Warning['where'], detail: string): Warning => ({ code, where, detail, blocks: false, overridden: null })

test('a clean application gives no warning at all', () => {
  assert.deepEqual(lint(CLEAN, CTX), [])
})

// — Placeholder —

test('placeholder: ANY bracket token of 1–80 characters, with no word list', () => {
  const warnings = lint(letter('Dear [Hiring Manager], I love [one specific thing about the company]. Call [phone]. {signature}'), CTX)
  assert.deepEqual(only(warnings, 'placeholder'), [
    block('placeholder', 'letter', '[Hiring Manager]'),
    block('placeholder', 'letter', '[one specific thing about the company]'),
    block('placeholder', 'letter', '[phone]'),
  ])
})

test('placeholder: in the subject, a form answer, the LinkedIn note and the CV, each with its where', () => {
  const artifacts: Artifacts = {
    ...letter('Hello. {signature}', 'Re: [Role]'),
    form: [{ question: 'Why us?', answer: 'Because TBD', ok: true, hint: null }],
    linkedin: 'Hi, TODO write this',
    cv: { ...DOC, summary: 'Lorem ipsum engineer' },
  }
  assert.deepEqual(only(lint(artifacts, CTX), 'placeholder'), [
    block('placeholder', 'subject', '[Role]'),
    block('placeholder', 'form', 'TBD'),
    block('placeholder', 'linkedin', 'TODO'),
    block('placeholder', 'cv', 'lorem'),
  ])
})

test('placeholder: a [x] inside a Markdown link is not let through — the text that is sent is plain', () => {
  const warnings = lint(letter('See [my work](https://alex.example.test). {signature}'), CTX)
  assert.deepEqual(only(warnings, 'placeholder'), [block('placeholder', 'letter', '[my work]')])
})

test('placeholder: an unknown {field} blocks; a known slot is filled and is NOT a placeholder', () => {
  const warnings = lint(letter('In {suburb}, at {company}. {signature}'), CTX)
  assert.deepEqual(only(warnings, 'placeholder'), [block('placeholder', 'letter', '{company}')])
})

test('placeholder: a bracket spanning a line break, or longer than 80, is not a token', () => {
  const long = `[${'x'.repeat(81)}]`
  assert.deepEqual(only(lint(letter(`a [b\nc] ${long} {signature}`), CTX), 'placeholder'), [])
})

test('placeholder in `to` (v5, X11): brackets, TODO, a {field} or not an email → where to', () => {
  for (const to of ['[MQ Careers email — TODO]', 'TODO', '{email}', 'careers at contoso', null]) {
    const warnings = lint(CLEAN, { ...CTX, to })
    assert.deepEqual(only(warnings, 'placeholder'), [block('placeholder', 'to', to === null ? 'no address' : 'not an email address')], String(to))
  }
})

test('placeholder in `to`: only an email application has one to check', () => {
  assert.deepEqual(lint(CLEAN, { ...CTX, channel: 'form', to: null }), [])
})

// — Slots —

test('a slot without its field gives its own code with the field, never placeholder', () => {
  const profile = withIdentity({ portfolioUrl: '', suburb: '' })
  const ctx = { ...CTX, profile }
  const warnings = lint({ ...letter('From {suburb}. Work: {portfolio}. {signature}'), contactHash: contactHashOf(profile) }, ctx)
  assert.deepEqual(warnings, [block('missing-profile-field', 'letter', 'suburb'), block('missing-portfolio', 'letter', 'portfolioUrl')])
})

test('{signature} without a name or email is missing-profile-field; without a phone, missing-phone', () => {
  const profile = withIdentity({ email: '', phone: '' })
  const warnings = lint({ ...letter('Thanks. {signature}'), contactHash: contactHashOf(profile) }, { ...CTX, profile })
  assert.deepEqual(only(warnings, 'missing-profile-field'), [block('missing-profile-field', 'letter', 'email')])
  assert.deepEqual(only(warnings, 'missing-phone'), [block('missing-phone', 'letter', 'phone'), block('missing-phone', 'cv', 'phone')])
})

// — Confidential name —

test('confidential name: without accents or capitals, whole word, also when it is an acronym', () => {
  const warnings = lint(cv({ summary: 'Built portals for acme hospital and for imss.' }), CTX)
  assert.deepEqual(only(warnings, 'confidential-name'), [block('confidential-name', 'cv', 'Acme Hospital'), block('confidential-name', 'cv', 'IMSS')])
  const accents = { ...PROFILE, confidential: ['Médica Sur'] }
  const folded = lint(letter('I worked with MEDICA SUR. {signature}'), { ...CTX, profile: accents })
  assert.deepEqual(only(folded, 'confidential-name'), [block('confidential-name', 'letter', 'Médica Sur')])
})

test('confidential name: a part of a longer word does not match', () => {
  assert.deepEqual(only(lint(cv({ summary: 'Built for imssx and preIMSS.' }), CTX), 'confidential-name'), [])
})

// — Health keyword —

test('health keyword at a non-health employer: exact capitals, whole word — «the HIS» and «HL7» block, «his team» does not', () => {
  const warnings = lint(cv({ summary: 'Integrated the HIS over HL7 for his team.' }), CTX)
  assert.deepEqual(only(warnings, 'health-keyword'), [block('health-keyword', 'cv', 'HL7'), block('health-keyword', 'cv', 'HIS')])
})

test('health keyword at a health employer: nothing', () => {
  const ctx = { ...CTX, company: { ...COMPANY, isHealthEmployer: true } }
  assert.deepEqual(only(lint(cv({ summary: 'Integrated the HIS over HL7.' }), ctx), 'health-keyword'), [])
})

// — Health mentions —

test('health mentions: more than 2 in one text blocks at a non-health employer; 2 do not', () => {
  const two = lint(cv({ summary: 'Shipped a clinical tool and a hospital portal.' }), CTX)
  assert.deepEqual(only(two, 'health-mentions'), [])
  const three = lint(cv({ summary: 'Shipped a Clinical tool, a hospital portal and patient apps for healthcare.' }), CTX)
  assert.deepEqual(only(three, 'health-mentions'), [block('health-mentions', 'cv', '4 mentions (at most 2)')])
  const plurals = lint(cv({ summary: 'Apps for patients, hospitals and clinics.' }), CTX)
  assert.deepEqual(only(plurals, 'health-mentions'), [block('health-mentions', 'cv', '3 mentions (at most 2)')])
  const healthCtx = { ...CTX, company: { ...COMPANY, isHealthEmployer: true } }
  assert.deepEqual(only(lint(cv({ summary: 'clinical hospital patient healthcare' }), healthCtx), 'health-mentions'), [])
})

// — Forbidden stack —

test('forbidden stack (CV): «Go microservices» and «Kafka» block; «go live», «Let’s go», «Google», «Gopher» do not', () => {
  const blocked = lint(cv({ summary: 'Wrote Go microservices on kafka.' }), CTX)
  assert.deepEqual(only(blocked, 'forbidden-stack'), [block('forbidden-stack', 'cv', 'Go'), block('forbidden-stack', 'cv', 'Kafka')])
  const fine = lint(cv({ summary: 'Helped the go live. Let’s go! Google and Gopher fans.' }), CTX)
  assert.deepEqual(only(fine, 'forbidden-stack'), [])
})

test('forbidden stack is a CV rule: the letter may name it', () => {
  assert.deepEqual(only(lint(letter('I have not used Go. {signature}'), CTX), 'forbidden-stack'), [])
})

// — Too long —

test('too long: an email over 150 words without the signature warns, and does not block', () => {
  const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ')
  assert.deepEqual(only(lint(letter(`${words(150)}\n\n{signature}`), CTX), 'too-long'), [])
  assert.deepEqual(only(lint(letter(`${words(151)}\n\n{signature}`), CTX), 'too-long'), [notice('too-long', 'letter', 'email 151 words (at most 150)')])
})

test('too long: a letter (not an email) over 220 words, a LinkedIn note over 280, a subject over 90', () => {
  const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ')
  const artifacts: Artifacts = { ...letter(words(221), 's'.repeat(91)), linkedin: 'l'.repeat(281) }
  assert.deepEqual(only(lint(artifacts, { ...CTX, channel: 'form', to: null }), 'too-long'), [
    notice('too-long', 'subject', 'subject 91 characters (at most 90)'),
    notice('too-long', 'letter', 'letter 221 words (at most 220)'),
    notice('too-long', 'linkedin', 'LinkedIn note 281 characters (at most 280)'),
  ])
})

// — Phone —

test('phone: an empty phone blocks the CV, whose contact needs it', () => {
  const profile = withIdentity({ phone: '' })
  const artifacts: Artifacts = { ...CLEAN, letter: null, contactHash: contactHashOf(profile) }
  assert.deepEqual(only(lint(artifacts, { ...CTX, profile, letterPending: true }), 'missing-phone'), [block('missing-phone', 'cv', 'phone')])
})

// — cv-stale —

test('cv-stale: a PDF printed with another contact blocks; one printed with today’s does not', () => {
  const stale = lint(CLEAN, { ...CTX, profile: withIdentity({ phone: '+61 400 999 999' }) })
  assert.deepEqual(only(stale, 'cv-stale'), [block('cv-stale', 'cv', 'printed with another contact')])
  const prose = lint(CLEAN, { ...CTX, profile: { ...PROFILE, availability: 'Changed' } })
  assert.deepEqual(only(prose, 'cv-stale'), [])
})

// — missing-cv —

test('missing-cv: no cv, no pdf, or the PDF not on disk', () => {
  assert.deepEqual(only(lint({ ...CLEAN, cv: null }, CTX), 'missing-cv'), [block('missing-cv', 'cv', 'no CV')])
  assert.deepEqual(only(lint({ ...CLEAN, pdf: null }, CTX), 'missing-cv'), [block('missing-cv', 'cv', 'no PDF')])
  assert.deepEqual(lint(CLEAN, { ...CTX, pdfExists: false }), [block('missing-cv', 'cv', 'the PDF is not on disk')])
})

// — missing-letter (v5 X8, v6 M9) —

test('missing-letter: a seeded application with its letter does not give it', () => {
  assert.deepEqual(only(lint({ ...CLEAN, origin: 'seed' }, CTX), 'missing-letter'), [])
})

test('missing-letter: no letter while one is still queued does not give it; the same after the third failure does', () => {
  const noLetter: Artifacts = { ...CLEAN, letter: null }
  assert.deepEqual(only(lint(noLetter, { ...CTX, letterPending: true }), 'missing-letter'), [])
  assert.deepEqual(only(lint(noLetter, { ...CTX, letterPending: false }), 'missing-letter'), [block('missing-letter', 'letter', 'no letter')])
})

test('missing-letter: only on the email channel — form, platform and linkedin never send a letter', () => {
  const noLetter: Artifacts = { ...CLEAN, letter: null }
  for (const channel of ['form', 'platform', 'linkedin'] as const) {
    assert.deepEqual(only(lint(noLetter, { ...CTX, channel, to: null }), 'missing-letter'), [], channel)
  }
  assert.deepEqual(only(lint(noLetter, { ...CTX, channel: 'email' }), 'missing-letter'), [block('missing-letter', 'letter', 'no letter')])
})

// — Senior title —

test('senior title: a title word of the profile in the ad’s title warns, and does not block', () => {
  const ctx = { ...CTX, opportunity: { ...OPPORTUNITY, title: 'Senior Platform Lead' } }
  assert.deepEqual(only(lint(CLEAN, ctx), 'senior-title'), [notice('senior-title', 'ad', 'senior'), notice('senior-title', 'ad', 'lead')])
  const leader = { ...CTX, opportunity: { ...OPPORTUNITY, title: 'Graduate, Leadership Programme' } }
  assert.deepEqual(only(lint(CLEAN, leader), 'senior-title'), [])
})

// — requirement-gap (v4 N2) —

test('requirement-gap: one notice per gap, only on vacancies, none blocking', () => {
  const gaps = [
    { requirement: 'Five years of Rust', why: 'No evidence' },
    { requirement: 'A security clearance', why: 'Not in cv-maestro' },
  ]
  const warnings = lint(cv({ gaps }), CTX)
  assert.deepEqual(only(warnings, 'requirement-gap'), [notice('requirement-gap', 'ad', 'Five years of Rust'), notice('requirement-gap', 'ad', 'A security clearance')])
  assert.equal(warnings.some((w) => w.blocks), false)
  const outreach = { ...CTX, opportunity: { ...OPPORTUNITY, kind: 'outreach' as const } }
  assert.deepEqual(only(lint(cv({ gaps }), outreach), 'requirement-gap'), [])
})

// — Order, purity, follow-ups —

test('the warnings come in the order of D6’s table, once each', () => {
  const profile = withIdentity({ phone: '' })
  const artifacts: Artifacts = { ...cv({ summary: 'TODO for IMSS with HL7 in Go.' }), letter: null }
  assert.deepEqual(codes(lint(artifacts, { ...CTX, profile })), [
    'placeholder',
    'confidential-name',
    'health-keyword',
    'forbidden-stack',
    'missing-phone',
    'cv-stale',
    'missing-letter',
  ])
})

test('lint is pure: the same input gives the same output and nothing is mutated', () => {
  const artifacts = structuredClone(CLEAN)
  const ctx = structuredClone(CTX)
  assert.deepEqual(lint(artifacts, ctx), lint(CLEAN, CTX))
  assert.deepEqual(artifacts, CLEAN)
  assert.deepEqual(ctx, CTX)
})

test('lintFollowup («seguimiento»): placeholder (also in to), slots, confidential name and too long — nothing else', () => {
  const profile = withIdentity({ phone: '' })
  const version = { subject: 'Following up — [Role] at IMSS', body: `${'word '.repeat(151)}\nHL7 in Go. {signature}` }
  assert.deepEqual(lintFollowup(version, { profile, channel: 'email', to: '[TODO]' }), [
    block('placeholder', 'to', 'not an email address'),
    block('placeholder', 'subject', '[Role]'),
    block('missing-phone', 'followup', 'phone'),
    block('confidential-name', 'subject', 'IMSS'),
    notice('too-long', 'followup', 'email 154 words (at most 150)'),
  ])
})

test('lintFollowup on LinkedIn: 280 characters, no subject, no address', () => {
  assert.deepEqual(lintFollowup({ subject: null, body: 'x'.repeat(281) }, { profile: PROFILE, channel: 'linkedin', to: null }), [
    notice('too-long', 'followup', 'LinkedIn note 281 characters (at most 280)'),
  ])
})

// — matchTerm (D6 «Cómo casan las listas de palabras») —

test('matchTerm: acronyms and short capitalised terms match with exact capitals, whole word', () => {
  assert.equal(matchTerm('the HIS', 'HIS'), true)
  assert.equal(matchTerm('his team', 'HIS'), false)
  assert.equal(matchTerm('Go microservices', 'Go'), true)
  for (const text of ['go live', 'Let’s go', 'Google', 'Gopher', 'Golang']) assert.equal(matchTerm(text, 'Go'), false, text)
  assert.equal(matchTerm('over HL7 v2', 'HL7'), true)
  assert.equal(matchTerm('HL70', 'HL7'), false)
  assert.equal(matchTerm('in C++ daily', 'C++'), true)
})

test('matchTerm: other terms match in any case and without accents, whole word', () => {
  assert.equal(matchTerm('KUBERNETES clusters', 'Kubernetes'), true)
  assert.equal(matchTerm('Senior engineer', 'senior'), true)
  assert.equal(matchTerm('seniority', 'senior'), false)
  assert.equal(matchTerm('Medica Sur', 'Médica Sur'), true)
})
