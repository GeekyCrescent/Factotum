import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRuleHint } from './rule-hint.ts'

test('an instruction that starts with always/never/siempre/nunca is a rule (criterion 33)', () => {
  for (const text of ['Always mention the AWS cert', 'never say passionate', 'Siempre en inglés australiano', 'NUNCA uses guiones largos']) {
    assert.equal(isRuleHint(text), true, text)
  }
})

test('leading spaces, quotes and brackets do not hide the word', () => {
  assert.equal(isRuleHint('   always shorter'), true)
  assert.equal(isRuleHint('"Never" use em dashes'), true)
  assert.equal(isRuleHint('(always) sign as Juan'), true)
})

test('the word after a comma counts too (criterion 33)', () => {
  assert.equal(isRuleHint('Shorter, and never mention health'), false)
  assert.equal(isRuleHint('Shorter, never mention health'), true)
  assert.equal(isRuleHint('Más corta,siempre con el link'), true)
  assert.equal(isRuleHint('Fine,   "always" first person'), true)
})

test('the word anywhere else is not a rule', () => {
  assert.equal(isRuleHint('Make it shorter, as always'), false)
  assert.equal(isRuleHint('I never asked for this paragraph'), false)
  assert.equal(isRuleHint('Shorter and nunca the cert'), false)
})

test('a longer word that begins the same is not the word', () => {
  assert.equal(isRuleHint('Neverland is not a company'), false)
  assert.equal(isRuleHint('Alwaysy'), false)
  assert.equal(isRuleHint('x, nevertheless shorter'), false)
})

test('an empty or blank instruction is not a rule', () => {
  assert.equal(isRuleHint(''), false)
  assert.equal(isRuleHint('   '), false)
})
