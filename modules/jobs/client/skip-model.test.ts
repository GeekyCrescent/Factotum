import { test } from 'node:test'
import assert from 'node:assert/strict'
import { skipDecision, skipReasonsFor } from './skip-model.ts'

test('an application can be skipped as not now, not a fit, duplicate or other, and «not a fit» says it closes', () => {
  const reasons = skipReasonsFor('application')
  assert.deepEqual(
    reasons.map((r) => r.reason),
    ['not-now', 'not-a-fit', 'duplicate', 'other'],
  )
  assert.equal(reasons.find((r) => r.reason === 'not-a-fit')?.closes, true)
  assert.equal(reasons.filter((r) => r.closes).length, 1)
})

test('a follow-up offers no reason that closes the application', () => {
  const reasons = skipReasonsFor('followup')
  assert.deepEqual(
    reasons.map((r) => r.reason),
    ['not-now', 'other'],
  )
})

test('a reason other than «other» is a skip decision with no text', () => {
  assert.deepEqual(skipDecision('not-a-fit', 'ignored'), { ok: true, decision: { kind: 'skip', reason: 'not-a-fit' } })
})

test('«other» needs a few words, and carries them trimmed', () => {
  assert.deepEqual(skipDecision('other', '   '), { ok: false, why: 'Say why in a few words' })
  assert.deepEqual(skipDecision('other', '  agency, not the company '), { ok: true, decision: { kind: 'skip', reason: 'other', text: 'agency, not the company' } })
})

test('«other» longer than the limit is refused before it is posted', () => {
  const outcome = skipDecision('other', 'x'.repeat(301))
  assert.equal(outcome.ok, false)
})
