import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { contactHashOf, cvContactOf, renderCvHtml } from './render.ts'
import { DOC, PROFILE } from './test-cv.ts'
import type { Profile } from '../types.ts'

/** Not a real font: render.ts only base64-encodes the bytes it is given. */
const FONT = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3])

const withIdentity = (identity: Partial<Profile['identity']>): Profile => ({ ...PROFILE, identity: { ...PROFILE.identity, ...identity } })

test('a <script> in a bullet, and quotes and ampersands anywhere, come out escaped', () => {
  const [first] = DOC.experience
  const doc = {
    ...DOC,
    headline: 'R&D "Engineer"',
    experience: [{ ...first!, bullets: [{ text: '<script>alert(1)</script>', source: '§1' }] }],
  }
  const { html } = renderCvHtml(doc, PROFILE, FONT)
  assert.equal(html.includes('<script'), false)
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('R&amp;D &quot;Engineer&quot;'))
})

test('the contact comes from the profile at print time: name, email, phone, LinkedIn, city, availability line', () => {
  const { html } = renderCvHtml(DOC, PROFILE, FONT)
  for (const value of ['Alex Example', 'alex@example.test', '+61 400 000 000', 'linkedin.com/in/alex-example', 'Sydney', 'Available from 4 Feb 2027 · 3 days a week']) {
    assert.ok(html.includes(value), value)
  }
})

test('without a phone nothing like [phone] is painted, and no separator dangles', () => {
  const { html } = renderCvHtml(DOC, withIdentity({ phone: '' }), FONT)
  assert.equal(html.includes('[phone]'), false)
  assert.equal(html.includes('phone'), false)
  assert.match(html, /<p class="contact">Sydney · alex@example\.test · linkedin\.com\/in\/alex-example<\/p>/)
})

test('the HTML stands alone: no file://, no http, no script; the font is a data: URI of the given bytes', () => {
  const { html } = renderCvHtml(DOC, withIdentity({ linkedin: 'https://www.linkedin.com/in/alex-example' }), FONT)
  assert.equal(html.includes('file://'), false)
  assert.equal(html.includes('http'), false)
  assert.equal(html.includes('<script'), false)
  assert.ok(html.includes(`url(data:font/woff2;base64,${Buffer.from(FONT).toString('base64')}) format('woff2')`))
  assert.ok(html.includes('linkedin.com/in/alex-example'))
})

test('A4 with a 12 mm margin', () => {
  const { html } = renderCvHtml(DOC, PROFILE, FONT)
  assert.match(html, /@page \{ size: A4; margin: 12mm \}/)
})

test('deterministic: the same doc and the same contact give the same HTML and the same hash', () => {
  assert.deepEqual(renderCvHtml(DOC, PROFILE, FONT), renderCvHtml(structuredClone(DOC), structuredClone(PROFILE), FONT))
})

test('the hash is sha256 of the canonical JSON of cvContactOf, and that is all render reads of the profile', () => {
  const contact = cvContactOf(PROFILE)
  assert.deepEqual(contact, {
    name: 'Alex Example',
    email: 'alex@example.test',
    phone: '+61 400 000 000',
    linkedin: 'linkedin.com/in/alex-example',
    city: 'Sydney',
    cvAvailabilityLine: 'Available from 4 Feb 2027 · 3 days a week',
  })
  const expected = createHash('sha256').update(JSON.stringify(contact)).digest('hex')
  assert.equal(contactHashOf(PROFILE), expected)
  assert.equal(renderCvHtml(DOC, PROFILE, FONT).contactHash, expected)
})

test('changing the phone changes the hash; changing the preferences does not', () => {
  const base = renderCvHtml(DOC, PROFILE, FONT).contactHash
  assert.notEqual(renderCvHtml(DOC, withIdentity({ phone: '+61 400 111 111' }), FONT).contactHash, base)
  const preferences = { ...PROFILE, preferences: { text: 'Anything', rateExpectation: 'A$99 per hour' } }
  assert.deepEqual(renderCvHtml(DOC, preferences, FONT), renderCvHtml(DOC, PROFILE, FONT))
})

test('B9: changing cvAvailabilityLine changes the hash; the prose availability and situation do not', () => {
  const base = renderCvHtml(DOC, PROFILE, FONT)
  assert.notEqual(renderCvHtml(DOC, withIdentity({ cvAvailabilityLine: 'Available now' }), FONT).contactHash, base.contactHash)
  const prose = { ...PROFILE, availability: 'Something else entirely', situation: 'Elsewhere' }
  assert.deepEqual(renderCvHtml(DOC, prose, FONT), base)
})

test('an empty cvAvailabilityLine leaves the line out of the HTML', () => {
  const { html } = renderCvHtml(DOC, withIdentity({ cvAvailabilityLine: '  ' }), FONT)
  assert.equal(html.includes('class="availability"'), false)
  assert.ok(renderCvHtml(DOC, PROFILE, FONT).html.includes('<p class="availability">'))
})

test('the gaps are never printed; the sections are, in order', () => {
  const doc = { ...DOC, gaps: [{ requirement: 'Ten years of Rust', why: 'No evidence' }] }
  const { html } = renderCvHtml(doc, PROFILE, FONT)
  assert.equal(html.includes('Ten years of Rust'), false)
  const order = ['Northwind Labs', 'Pathfinder', 'Master of IT', 'Cloud Associate · Data Practitioner', 'Languages']
  const at = order.map((text) => html.indexOf(text))
  assert.ok(at.every((index) => index > 0), String(at))
  assert.deepEqual([...at].sort((a, b) => a - b), at)
})

test('an empty section is left out, and a role without a place or a line prints no empty element', () => {
  const [first] = DOC.experience
  const doc = { ...DOC, projects: [], certifications: [], experience: [{ ...first!, place: null, line: null }] }
  const { html } = renderCvHtml(doc, PROFILE, FONT)
  assert.equal(html.includes('>Projects<'), false)
  assert.equal(html.includes('>Certifications<'), false)
  assert.equal(html.includes('class="place"'), false)
  assert.equal(html.includes('class="line"'), false)
})
