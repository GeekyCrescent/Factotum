import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReviewItem } from './contract.ts'
import { afterTextOf, rewrittenView, stillRewriting } from './rewrite-model.ts'
import { application, followup, rewrite } from './test-fixtures.ts'

test('a rewrite that came back shows its tag, the word diff and «before → after words»', () => {
  const view = rewrittenView(rewrite({ before: 'Hi Sean, a long letter', instruction: 'shorter' }), 'Hi Sean, a letter')
  assert.equal(view.tag, 'rewritten · “shorter”')
  assert.equal(view.failed, false)
  assert.equal(view.count, '5 → 4 words')
  assert.deepEqual(
    view.parts?.filter((p) => p.kind !== 'same').map((p) => [p.kind, p.text.trim()]),
    [['del', 'long']],
  )
  assert.equal(view.retry, null)
})

test('a failed rewrite says so with its reason, shows no diff, and offers the same instruction again (A4)', () => {
  const view = rewrittenView(rewrite({ failed: true, instruction: 'shorter', reason: 'the AI timed out' }), 'Hi Sean, a long letter')
  assert.equal(view.tag, 'rewrite failed · “shorter”')
  assert.equal(view.reason, 'the AI timed out')
  assert.equal(view.parts, null)
  assert.equal(view.count, null)
  assert.equal(view.retry, 'shorter')
})

test('a failed rewrite without its instruction offers nothing to try again', () => {
  const view = rewrittenView(rewrite({ failed: true, instruction: null }), 'x')
  assert.equal(view.tag, 'rewrite failed')
  assert.equal(view.retry, null)
})

test('without the text before, or after, there is no diff to draw', () => {
  assert.equal(rewrittenView(rewrite({ before: null }), 'x').parts, null)
  assert.equal(rewrittenView(rewrite(), null).parts, null)
  assert.equal(rewrittenView(rewrite(), null).count, null)
})

test('the text a rewrite is compared on: the letter, the LinkedIn note of a LinkedIn application, the follow-up body', () => {
  const app: ReviewItem = { itemId: 'i', seen: 's', kind: 'rewritten', target: 'application', application: application(), rewrite: rewrite() }
  assert.equal(afterTextOf(app), 'Hi Sean')
  const note: ReviewItem = { ...app, application: application({ channel: 'linkedin', linkedin: 'Hi Tom' }) } as ReviewItem
  assert.equal(afterTextOf(note), 'Hi Tom')
  const noLetter: ReviewItem = { ...app, application: application({ letter: null }) } as ReviewItem
  assert.equal(afterTextOf(noLetter), null)
  const f: ReviewItem = { itemId: 'i', seen: 's', kind: 'rewritten', target: 'followup', followup: followup({ body: 'Hi again' }), rewrite: rewrite() }
  assert.equal(afterTextOf(f), 'Hi again')
  assert.equal(afterTextOf({ itemId: 'i', seen: 's', kind: 'proposal', proposalId: 'p' }), null)
})

test('«1 still rewriting…» while some rewrite has not come back, nothing at zero', () => {
  assert.equal(stillRewriting(0), null)
  assert.equal(stillRewriting(1), '1 still rewriting…')
  assert.equal(stillRewriting(3), '3 still rewriting…')
})
