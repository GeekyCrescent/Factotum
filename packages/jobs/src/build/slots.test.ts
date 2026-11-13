import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fillSlots, isSlotName, RATE_NEUTRAL, signatureOf, SLOT_NAMES, SLOT_WARNING, slotsPreserved } from './slots.ts'
import type { Profile } from '../types.ts'

const seed = (): Profile => JSON.parse(readFileSync(new URL('../../assets/profile-seed.json', import.meta.url), 'utf8')) as Profile
const withIdentity = (patch: Partial<Profile['identity']>): Profile => {
  const profile = seed()
  return { ...profile, identity: { ...profile.identity, ...patch } }
}

test('the signature is name · email · phone · LinkedIn, from the profile of the moment', () => {
  assert.equal(
    signatureOf(seed()),
    'Juan Rodrigo Ferro Rayón · ferro.rayon@gmail.com · +61 401 555 638 · linkedin.com/in/juan-rodrigo-ferro-rayón-7a0039334',
  )
  assert.equal(signatureOf(withIdentity({ linkedin: '' })), 'Juan Rodrigo Ferro Rayón · ferro.rayon@gmail.com · +61 401 555 638')
})

test('a signature needs name, email AND phone: without one there is none, never a partial one', () => {
  assert.equal(signatureOf(withIdentity({ email: '  ' })), null)
  assert.equal(signatureOf(withIdentity({ name: '' })), null)
  assert.equal(signatureOf(withIdentity({ phone: '' })), null)
})

test('{signature} with a phone but no name or email stays as it was, blocked by missing-profile-field with the field', () => {
  assert.deepEqual(fillSlots('Thanks,\n{signature}', withIdentity({ email: '' })), {
    text: 'Thanks,\n{signature}',
    missing: ['signature'],
    blocks: [{ slot: 'signature', code: 'missing-profile-field', field: 'email' }],
  })
  assert.deepEqual(fillSlots('{signature}', withIdentity({ name: ' ', email: '', phone: '' })).blocks, [
    { slot: 'signature', code: 'missing-profile-field', field: 'name' },
    { slot: 'signature', code: 'missing-profile-field', field: 'email' },
    { slot: 'signature', code: 'missing-phone', field: 'phone' },
  ])
})

test('every slot of the table is filled from its field', () => {
  const text = 'Best,\n{signature}\nI live in {suburb}; I will be in {timezone}. Rate: {rate} Work: {portfolio}'
  const filled = fillSlots(text, withIdentity({ suburb: 'Eastwood' }))
  assert.deepEqual(filled.missing, [])
  const expected = `Best,\n${signatureOf(seed())}\nI live in Eastwood; I will be in Australia/Sydney. Rate: ${RATE_NEUTRAL} Work: https://geekycrescent.github.io/`
  assert.equal(filled.text, expected)
})

test('{signature} without a phone is missing, and the slot stays as it was (→ missing-phone)', () => {
  const filled = fillSlots('Thanks,\n{signature}', withIdentity({ phone: '' }))
  assert.deepEqual(filled, { text: 'Thanks,\n{signature}', missing: ['signature'], blocks: [{ slot: 'signature', code: 'missing-phone', field: 'phone' }] })
  assert.equal(SLOT_WARNING.signature, 'missing-phone')
})

test('{rate} empty gives the neutral sentence of the kit and NO missing (v7, the owner\'s decision)', () => {
  assert.equal(RATE_NEUTRAL, "I'm open to the advertised range.")
  assert.deepEqual(fillSlots('{rate}', seed()), { text: RATE_NEUTRAL, missing: [], blocks: [] })
  const set = seed()
  const withRate: Profile = { ...set, preferences: { ...set.preferences, rateExpectation: 'A$45 per hour' } }
  assert.deepEqual(fillSlots('Rate: {rate}', withRate), { text: 'Rate: A$45 per hour', missing: [], blocks: [] })
})

test('{portfolio} empty is missing (→ missing-portfolio); {suburb} and {timezone} empty (→ missing-profile-field)', () => {
  assert.deepEqual(fillSlots('See {portfolio}', withIdentity({ portfolioUrl: '' })), { text: 'See {portfolio}', missing: ['portfolio'], blocks: [{ slot: 'portfolio', code: 'missing-portfolio', field: 'portfolioUrl' }] })
  assert.deepEqual(fillSlots('{suburb} {timezone}', withIdentity({ suburb: ' ', timezone: '' })).blocks, [
    { slot: 'suburb', code: 'missing-profile-field', field: 'suburb' },
    { slot: 'timezone', code: 'missing-profile-field', field: 'timezone' },
  ])
  assert.equal(SLOT_WARNING.portfolio, 'missing-portfolio')
  assert.equal(SLOT_WARNING.suburb, 'missing-profile-field')
  assert.equal(SLOT_WARNING.timezone, 'missing-profile-field')
  assert.equal(SLOT_WARNING.rate, null)
})

test('a missing slot is named once, in the order it first appears', () => {
  const filled = fillSlots('{portfolio} {signature} {portfolio}', withIdentity({ phone: '', portfolioUrl: '' }))
  assert.deepEqual(filled.missing, ['portfolio', 'signature'])
})

test('an unknown {x} and the follow-up fields are left alone (L1 blocks the unknown one)', () => {
  const text = 'Hi {greetingName}, about {role} at {company}: {x} {Signature}'
  assert.deepEqual(fillSlots(text, seed()), { text, missing: [], blocks: [] })
})

test('the slot names of today', () => {
  assert.deepEqual(SLOT_NAMES, ['signature', 'suburb', 'timezone', 'rate', 'portfolio'])
  assert.equal(isSlotName('rate'), true)
  assert.equal(isSlotName('role'), false)
})

test('a value with a $ pattern is copied literally', () => {
  const set = seed()
  const profile: Profile = { ...set, preferences: { ...set.preferences, rateExpectation: "A$45 $& $' an hour" } }
  assert.equal(fillSlots('{rate}', profile).text, "A$45 $& $' an hour")
})

// ── slotsPreserved (design D10 «Los huecos sobreviven a la reescritura», v4 B2) ───────────────────

const LETTER = { subject: 'Application', body: 'Dear Ada,\n\nSee {portfolio}.\n\n{signature}', 'form.0': 'From {suburb}, {timezone}.' }

test('the same slots in every field, moved around or with other words: preserved', () => {
  const after = { subject: 'Application — shorter', body: 'Hi Ada. {portfolio}\n{signature}', 'form.0': '{timezone}; I live in {suburb}.' }
  assert.equal(slotsPreserved(LETTER, after), true)
})

test('a {signature} lost: not preserved', () => {
  assert.equal(slotsPreserved(LETTER, { ...LETTER, body: 'Dear Ada,\n\nSee {portfolio}.\n\nJuan' }), false)
})

test('a {portfolio} filled with a URL: not preserved', () => {
  assert.equal(slotsPreserved(LETTER, { ...LETTER, body: 'Dear Ada,\n\nSee https://github.com/x.\n\n{signature}' }), false)
})

test('a slot added, even one known elsewhere in the text: not preserved', () => {
  assert.equal(slotsPreserved(LETTER, { ...LETTER, subject: 'Application {rate}' }), false)
  assert.equal(slotsPreserved(LETTER, { ...LETTER, body: `${LETTER.body}\n{signature}` }), false)
})

test('by field: a slot moved from one field to another is not preserved', () => {
  assert.equal(slotsPreserved(LETTER, { ...LETTER, body: 'Dear Ada,\n\nSee {portfolio}. {suburb}\n\n{signature}', 'form.0': 'From here, {timezone}.' }), false)
})

test('a field gone counts as empty: its slots are lost', () => {
  const { 'form.0': _, ...without } = LETTER
  assert.equal(slotsPreserved(LETTER, without), false)
  assert.equal(slotsPreserved({ subject: null, body: '{signature}' }, { subject: null, body: '{signature}' }), true)
})

test('allowDrop portfolio may remove {portfolio}, never add one, and nothing else', () => {
  const dropped = { ...LETTER, body: 'Dear Ada,\n\n{signature}' }
  assert.equal(slotsPreserved(LETTER, dropped, { allowDrop: ['portfolio'] }), true)
  assert.equal(slotsPreserved(LETTER, LETTER, { allowDrop: ['portfolio'] }), true)
  assert.equal(slotsPreserved(LETTER, { ...LETTER, subject: 'See {portfolio}' }, { allowDrop: ['portfolio'] }), false)
  assert.equal(slotsPreserved(LETTER, { ...dropped, body: 'Dear Ada' }, { allowDrop: ['portfolio'] }), false)
})

test('an unknown {field} is not a slot: the linter judges it, not this', () => {
  assert.equal(slotsPreserved({ body: 'Hi {name}' }, { body: 'Hi Ada' }), true)
})
