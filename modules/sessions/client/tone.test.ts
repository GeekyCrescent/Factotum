import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROJECT_TONES, toneClass, toneOf } from './tone.ts'

test('a project always gets the same colour', () => {
  assert.equal(toneOf('proyecto-a'), toneOf('proyecto-a'))
})

test('the colour is one of the six, numbered from 1', () => {
  for (const site of ['a', 'demo', 'proyecto-b', '', 'ñandú', 'x'.repeat(200)]) {
    const tone = toneOf(site)
    assert.ok(Number.isInteger(tone) && tone >= 1 && tone <= PROJECT_TONES, `${site}: ${tone}`)
  }
})

test('different projects spread over the colours instead of piling on one', () => {
  const used = new Set(Array.from({ length: 40 }, (_, i) => toneOf(`site-${i}`)))
  assert.equal(used.size, PROJECT_TONES)
})

test('two names that differ by one letter usually differ in colour', () => {
  assert.notEqual(toneOf('proyecto-a'), toneOf('proyecto-b'))
})

test('A COLOUR THE OWNER PICKED wins; without one, or out of range, the one from the id (criterion 26)', () => {
  assert.equal(toneClass('proyecto-a', 5), 's-p5')
  assert.equal(toneClass('proyecto-a'), `s-p${toneOf('proyecto-a')}`)
  assert.equal(toneClass('proyecto-a', 9), `s-p${toneOf('proyecto-a')}`)
})
