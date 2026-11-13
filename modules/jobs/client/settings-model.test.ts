import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Profile } from './contract.ts'
import { afterSave, anchorOfField, fieldOf, formOf, profileOf, savedLine, type ProfileForm } from './settings-model.ts'

const PROFILE: Profile = {
  identity: {
    name: 'Ana Example',
    email: 'ana@example.com',
    phone: '+61 400 000 000',
    linkedin: 'linkedin.com/in/ana',
    city: 'Sydney',
    suburb: 'Glebe',
    timezone: 'Australia/Sydney',
    portfolioUrl: '',
    cvAvailabilityLine: 'Available Jan to Jul',
  },
  situation: 'In Sydney.',
  availability: 'From January.',
  absences: [{ from: '2026-11-26', to: '2027-01-10', label: 'Away from Sydney' }],
  goals: [
    { id: 'part-time', label: 'Part-time', enabled: true, text: 'Part-time roles', payFloor: null, sources: ['seek', 'lever'] },
    { id: 'money', label: 'Money', enabled: false, text: 'Contract work', payFloor: { amount: 45, currency: 'AUD', per: 'hour' }, sources: [] },
  ],
  level: 'Junior.',
  redLines: { text: 'Nothing senior.', titleWords: ['senior', 'lead'], requirementWords: ['clearance'], unpaid: true, equityOnly: true },
  preferences: { text: 'AI teams.', rateExpectation: '' },
  forbiddenStacks: ['COBOL'],
  confidential: ['Clinic X'],
  batchSize: 10,
  weights: { partTime: 30, skills: 25, hiring: 20, visa: 15, access: 10 },
  followup: { subject: 'Following up', first: 'Hi {greetingName}', second: 'Hi again {greetingName}', linkedin: 'Hi' },
}

const roundTrip = (form: ProfileForm) => profileOf(form, PROFILE)

test('a profile read into the form and back, untouched, is the same profile', () => {
  assert.deepEqual(roundTrip(formOf(PROFILE)), { ok: true, profile: PROFILE })
})

test('the lists are one per line in the form; blank lines and spaces go', () => {
  const form = formOf(PROFILE)
  assert.equal(form.titleWords, 'senior\nlead')
  const out = roundTrip({ ...form, titleWords: '  senior \n\n lead\nprincipal  \n' })
  assert.ok(out.ok)
  assert.deepEqual(out.profile.redLines.titleWords, ['senior', 'lead', 'principal'])
})

test('an absence is one line «from → to label», and a line that does not read says which', () => {
  const form = formOf(PROFILE)
  assert.equal(form.absences, '2026-11-26 → 2027-01-10 Away from Sydney')
  const out = roundTrip({ ...form, absences: '2027-03-01 → 2027-03-05 Exams\n2027-04-01 2027-04-02 Easter' })
  assert.ok(out.ok)
  assert.deepEqual(out.profile.absences, [
    { from: '2027-03-01', to: '2027-03-05', label: 'Exams' },
    { from: '2027-04-01', to: '2027-04-02', label: 'Easter' },
  ])
  assert.deepEqual(roundTrip({ ...form, absences: 'next week' }), { ok: false, field: 'absences', why: 'Line 1 is not «YYYY-MM-DD → YYYY-MM-DD label»' })
})

test('a goal keeps its id; its pay floor reads «45 AUD per hour» and empty is none', () => {
  const form = formOf(PROFILE)
  assert.equal(form.goals[1]?.payFloor, '45 AUD per hour')
  assert.equal(form.goals[0]?.payFloor, '')
  assert.equal(form.goals[0]?.sources, 'seek, lever')
  const goals = form.goals.map((goal, at) => (at === 0 ? { ...goal, payFloor: '90000 aud per year', enabled: false } : goal))
  const out = roundTrip({ ...form, goals })
  assert.ok(out.ok)
  assert.deepEqual(out.profile.goals[0], { id: 'part-time', label: 'Part-time', enabled: false, text: 'Part-time roles', payFloor: { amount: 90000, currency: 'AUD', per: 'year' }, sources: ['seek', 'lever'] })
  const bad = form.goals.map((goal, at) => (at === 0 ? { ...goal, payFloor: 'lots' } : goal))
  assert.deepEqual(roundTrip({ ...form, goals: bad }), { ok: false, field: 'goals.0.payFloor', why: 'A pay floor reads like «45 AUD per hour», or is empty' })
})

test('the batch size and the weights are whole numbers; anything else says which field', () => {
  const form = formOf(PROFILE)
  assert.equal(form.batchSize, '10')
  assert.deepEqual(roundTrip({ ...form, batchSize: 'ten' }), { ok: false, field: 'batchSize', why: 'A whole number' })
  assert.deepEqual(roundTrip({ ...form, weights: { ...form.weights, visa: '1.5' } }), { ok: false, field: 'weights.visa', why: 'A whole number' })
  const out = roundTrip({ ...form, batchSize: ' 12 ' })
  assert.ok(out.ok)
  assert.equal(out.profile.batchSize, 12)
})

test('the texts and the identity go as written (the engine validates them)', () => {
  const form = formOf(PROFILE)
  const out = roundTrip({ ...form, identity: { ...form.identity, portfolioUrl: 'https://ana.dev' }, situation: 'Moved.', rateExpectation: 'A$45 per hour' })
  assert.ok(out.ok)
  assert.equal(out.profile.identity.portfolioUrl, 'https://ana.dev')
  assert.equal(out.profile.situation, 'Moved.')
  assert.equal(out.profile.preferences.rateExpectation, 'A$45 per hour')
})

test('«Saved as version N», with what the re-lint changed when it changed any', () => {
  assert.equal(savedLine({ version: 4, relinted: 0 }), 'Saved as version 4')
  assert.equal(savedLine({ version: 5, relinted: 1 }), 'Saved as version 5 · 1 application re-checked')
  assert.equal(savedLine({ version: 6, relinted: 3 }), 'Saved as version 6 · 3 applications re-checked')
})

test('the field of a 400 is read from the answer, and leads to its place on the page', () => {
  assert.equal(fieldOf({ status: 400, body: { error: { code: 'invalid', message: 'x', field: 'identity.phone' } } }), 'identity.phone')
  assert.equal(fieldOf({ status: 400, body: {} }), null)
  assert.equal(fieldOf(new Error('x')), null)
  assert.equal(anchorOfField('identity.phone'), 'phone')
  assert.equal(anchorOfField('identity.portfolioUrl'), 'portfolio')
  assert.equal(anchorOfField('preferences.rateExpectation'), 'rate')
  assert.equal(anchorOfField('goals.0.payFloor'), 'goals')
  assert.equal(anchorOfField('followup.first'), 'followup')
  assert.equal(anchorOfField('<script>'), 'identity')
})

test('a save that comes back takes the saved profile, unless the owner typed meanwhile: then the typing stays', () => {
  const posted = formOf(PROFILE)
  const saved: Profile = { ...PROFILE, situation: 'saved by the engine' }
  assert.equal(afterSave(posted, posted, saved).situation, 'saved by the engine')
  const typed: ProfileForm = { ...posted, situation: 'typed during the save' }
  assert.equal(afterSave(typed, posted, saved), typed)
  assert.equal(afterSave(null, posted, saved).situation, 'saved by the engine')
})
