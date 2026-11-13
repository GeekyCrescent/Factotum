import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Rule } from './contract.ts'
import { editOf, newRuleOf, RULE_SCOPES, sortedRules } from './rules-model.ts'

const rule = (over: Partial<Rule> = {}): Rule => ({ id: 'r1', text: 'Never mention health', scope: 'all', enabled: true, createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z', ...over })

test('a rule is for all, or for one channel', () => {
  assert.deepEqual(
    RULE_SCOPES.map((s) => s.scope),
    ['all', 'email', 'form', 'platform', 'linkedin'],
  )
})

test('a new rule has 1 to 300 characters, trimmed', () => {
  assert.deepEqual(newRuleOf('  Always sign as Ana ', 'email'), { ok: true, body: { text: 'Always sign as Ana', scope: 'email' } })
  assert.deepEqual(newRuleOf('   ', 'all'), { ok: false, why: 'A rule needs its words' })
  assert.deepEqual(newRuleOf('x'.repeat(301), 'all'), { ok: false, why: 'A rule is at most 300 characters' })
})

test('an edit posts only what changed, and nothing at all when nothing did', () => {
  assert.deepEqual(editOf(rule(), 'Never mention health ', 'all'), { ok: true, body: null })
  assert.deepEqual(editOf(rule(), 'Never mention clinics', 'all'), { ok: true, body: { text: 'Never mention clinics' } })
  assert.deepEqual(editOf(rule(), 'Never mention health', 'form'), { ok: true, body: { scope: 'form' } })
  assert.equal(editOf(rule(), '', 'all').ok, false)
})

test('the rules on, newest first, then the ones switched off', () => {
  const rules = [rule({ id: 'old', updatedAt: '2026-11-01T00:00:00Z' }), rule({ id: 'off', enabled: false, updatedAt: '2026-11-20T00:00:00Z' }), rule({ id: 'new', updatedAt: '2026-11-12T00:00:00Z' })]
  assert.deepEqual(
    sortedRules(rules).map((r) => r.id),
    ['new', 'old', 'off'],
  )
})
