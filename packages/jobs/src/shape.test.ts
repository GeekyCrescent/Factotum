import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  hasTemplateDebris,
  isAbsolutePath,
  isCalendarDate,
  isRelativePath,
  isSendableAddress,
  MAX_REQUIREMENTS_CHARS,
  shape,
} from './shape.ts'

test('a calendar date is YYYY-MM-DD and a real day', () => {
  assert.equal(isCalendarDate('2027-01-12'), true)
  assert.equal(isCalendarDate('2026-02-30'), false)
  assert.equal(isCalendarDate('2027-1-12'), false)
  assert.equal(isCalendarDate('12/01/2027'), false)
})

test('an absolute path starts at the root and never climbs', () => {
  assert.equal(isAbsolutePath('/home/ferro/Ferro/Obsidian'), true)
  assert.equal(isAbsolutePath('relative/path'), false)
  assert.equal(isAbsolutePath('/home/../etc'), false)
  assert.equal(isAbsolutePath('/home/a\0b'), false)
  assert.equal(isAbsolutePath(''), false)
})

test('a vault path is relative, without "..", and may name a folder', () => {
  assert.equal(isRelativePath('03-life/carrera/cv-maestro.md'), true)
  assert.equal(isRelativePath('03-life/carrera/postulaciones/'), true)
  assert.equal(isRelativePath('/abs/path.md'), false)
  assert.equal(isRelativePath('03-life/../../etc/passwd'), false)
  assert.equal(isRelativePath('..'), false)
  assert.equal(isRelativePath(''), false)
  assert.equal(isRelativePath('a\0b'), false)
})

test('the address rule of D6 takes a real address and refuses brackets, braces and spaces', () => {
  assert.equal(isSendableAddress('ferro.rayon@gmail.com'), true)
  assert.equal(isSendableAddress('[correo]@company.com'), false)
  assert.equal(isSendableAddress('{email}'), false)
  assert.equal(isSendableAddress('two words@company.com'), false)
  assert.equal(isSendableAddress('nobody@localhost'), false)
})

test('template debris is a bracket token, TODO or TBD', () => {
  assert.equal(hasTemplateDebris('Hi {greetingName}'), false)
  assert.equal(hasTemplateDebris('Hi [Name]'), true)
  assert.equal(hasTemplateDebris('TODO: write it'), true)
  assert.equal(hasTemplateDebris('rate TBD'), true)
  assert.equal(hasTemplateDebris('Stodot is a word'), false)
})

test('the ad limit is 16 KiB', () => {
  assert.equal(MAX_REQUIREMENTS_CHARS, 16 * 1024)
})

const schema = z.strictObject({ name: z.string().max(5, 'name is at most 5 characters'), inner: z.strictObject({ n: z.number() }).optional() })

test('shape gives the value without keys whose value is undefined', () => {
  const shaped = shape<{ name: string }>(schema, { name: 'ok', inner: undefined })
  assert.deepEqual(shaped, { ok: true, value: { name: 'ok' } })
})

test('shape refuses a non-object body', () => {
  for (const raw of [null, 'text', [1], 3]) {
    const shaped = shape(schema, raw)
    assert.equal(shaped.ok, false)
    if (!shaped.ok) assert.deepEqual(shaped.error, { code: 'invalid', field: 'body', reason: 'the body must be a JSON object' })
  }
})

test('shape names the field of the first issue, and the reason does not carry the value', () => {
  const shaped = shape(schema, { name: 'secret-value' })
  assert.equal(shaped.ok, false)
  if (shaped.ok) return
  assert.equal(shaped.error.code, 'invalid')
  assert.equal(shaped.error.field, 'name')
  assert.ok(!shaped.error.reason.includes('secret-value'))
})

test('shape names an unknown key by its path', () => {
  const shaped = shape(schema, { name: 'a', inner: { n: 1, typo: 'secret-value' } })
  assert.equal(shaped.ok, false)
  if (shaped.ok) return
  assert.equal(shaped.error.field, 'inner.typo')
  assert.ok(!shaped.error.reason.includes('secret-value'))
})
