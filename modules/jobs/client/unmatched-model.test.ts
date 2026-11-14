import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AssignOption, UnmatchedReply } from './contract.ts'
import { assignChoices, unmatchedHeading } from './unmatched-model.ts'

const APPS: readonly AssignOption[] = [
  { id: 'a-acme', company: 'Acme', role: 'Graduate engineer', state: 'sent' },
  { id: 'a-beta', company: 'Beta', role: 'Data analyst', state: 'replied' },
  { id: 'a-gamma', company: 'Gamma', role: 'Platform engineer', state: 'closed' },
]

const reply = (over: Partial<UnmatchedReply> = {}): UnmatchedReply => ({
  key: '7:12',
  at: '2026-11-13T05:00:00.000Z',
  from: 'hr@unknown.example',
  subject: 'Your interview',
  link: null,
  class: null,
  summary: null,
  candidates: [],
  ...over,
})

test('«Assign to…»: the reader’s candidates first, then the rest in the engine’s order, each «Company — Role»', () => {
  assert.deepEqual(
    assignChoices(reply({ candidates: ['a-gamma'] }), APPS).map((c) => [c.id, c.label, c.suggested]),
    [
      ['a-gamma', 'Gamma — Platform engineer', true],
      ['a-acme', 'Acme — Graduate engineer', false],
      ['a-beta', 'Beta — Data analyst', false],
    ],
  )
})

test('«Assign to…»: a candidate the list no longer has is left out; no candidates → the list as it is', () => {
  assert.deepEqual(assignChoices(reply({ candidates: ['gone', 'a-beta'] }), APPS).map((c) => c.id), ['a-beta', 'a-acme', 'a-gamma'])
  assert.deepEqual(assignChoices(reply(), APPS).map((c) => c.id), ['a-acme', 'a-beta', 'a-gamma'])
})

test('the heading says how many wait, and nothing when none does', () => {
  assert.equal(unmatchedHeading(0), null)
  assert.equal(unmatchedHeading(1), 'Unmatched reply')
  assert.equal(unmatchedHeading(3), '3 unmatched replies')
})
