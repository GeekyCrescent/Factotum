import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReviewItem } from './contract.ts'
import { assistOf, closesOpenPanel, copyButton } from './assist-model.ts'
import { appItem, followup } from './test-fixtures.ts'

const FORM_ANSWER = { question: 'Work rights?', answer: 'Student visa, 48 h per fortnight', ok: true, hint: 'choose the temporary-visa option' }

test('a form application: Open ad, Open form, Copy for the letter, each answer and the note, the skills, the CV and Mark as sent', () => {
  const view = assistOf(
    appItem({
      channel: 'form',
      targetUrl: 'https://acme.io/apply',
      letter: { subject: null, body: 'Dear Acme' },
      form: [FORM_ANSWER],
      linkedin: 'Hi Tom',
      skills: { tick: ['React', 'AWS'], doNotTick: ['Java'] },
    }),
  )
  assert.ok(view !== null)
  assert.equal(view.title, 'Apply on the form')
  assert.deepEqual(view.links, [
    { label: 'Open ad', href: 'https://acme.io/job' },
    { label: 'Open form', href: 'https://acme.io/apply' },
  ])
  assert.deepEqual(
    view.copies.map((c) => [c.label, c.text]),
    [
      ['Cover letter', 'Dear Acme'],
      ['Work rights?', 'Student visa, 48 h per fortnight'],
      ['LinkedIn note', 'Hi Tom'],
    ],
  )
  assert.deepEqual(view.skills, { tick: ['React', 'AWS'], doNotTick: ['Java'] })
  assert.equal(view.pdf, 'a/app-1/v/2/cv.pdf')
  assert.deepEqual(view.mark, { applicationId: 'app-1', kind: 'initial', company: 'Acme' })
})

test('an answer’s hint is shown beside it and never in what is copied', () => {
  const view = assistOf(appItem({ channel: 'platform', form: [FORM_ANSWER] }))
  const answer = view?.copies.find((c) => c.label === 'Work rights?')
  assert.equal(answer?.hint, 'choose the temporary-visa option')
  assert.equal(answer?.text.includes('temporary-visa'), false)
})

test('the form link is not repeated when it is the ad, and a link that is not http(s) is never drawn', () => {
  const same = assistOf(appItem({ channel: 'platform', adUrl: 'https://seek.com/1', targetUrl: 'https://seek.com/1' }))
  assert.deepEqual(same?.links, [{ label: 'Open ad', href: 'https://seek.com/1' }])
  const evil = assistOf(appItem({ channel: 'form', adUrl: 'javascript:alert(1)', targetUrl: null }))
  assert.deepEqual(evil?.links, [])
})

test('a LinkedIn application: its instruction on top, the message to copy, the CV and Mark as sent, no Open ad (B1)', () => {
  const view = assistOf(appItem({ channel: 'linkedin', instruction: 'LinkedIn message to Tom Crawford (first)', linkedin: 'Hi Tom', letter: null }))
  assert.equal(view?.title, 'LinkedIn message')
  assert.equal(view?.instruction, 'LinkedIn message to Tom Crawford (first)')
  assert.deepEqual(view?.links, [])
  assert.deepEqual(
    view?.copies.map((c) => [c.label, c.text]),
    [['Message', 'Hi Tom']],
  )
  assert.equal(view?.mark?.kind, 'initial')
})

test('an email with a LinkedIn note: after the send, only the note to copy, nothing to mark', () => {
  const view = assistOf(appItem({ channel: 'email', linkedin: 'Hi Tom' }))
  assert.equal(view?.title, 'LinkedIn note')
  assert.deepEqual(
    view?.copies.map((c) => c.text),
    ['Hi Tom'],
  )
  assert.equal(view?.mark, null)
  assert.equal(view?.pdf, null)
})

test('an email without a note has no panel', () => {
  assert.equal(assistOf(appItem({ channel: 'email', linkedin: null })), null)
})

test('a LinkedIn follow-up: its body to copy and Mark as sent on its own send; an email follow-up has no panel', () => {
  const item: ReviewItem = { itemId: 'f', seen: 's', kind: 'followup', followup: followup({ channel: 'linkedin', n: 2, body: 'Ping' }) }
  const view = assistOf(item)
  assert.deepEqual(view?.mark, { applicationId: 'app-1', kind: 'followup-2', company: 'Acme' })
  assert.deepEqual(
    view?.copies.map((c) => c.text),
    ['Ping'],
  )
  assert.equal(assistOf({ ...item, followup: followup() } as ReviewItem), null)
  assert.equal(assistOf({ itemId: 'p', seen: 's', kind: 'proposal', proposalId: 'p' }), null)
})

test('a CV path that is not a plain module path is not offered for download', () => {
  const view = assistOf(appItem({ channel: 'form', cv: { base: 'A', png: null, pdf: '../../etc/passwd', tailored: null } }))
  assert.equal(view?.pdf, null)
})

test('a panel closes once: a late close (after «Later», or a «Mark as sent» answered after it) moves the review on nothing', () => {
  const panel = { from: 2 }
  assert.equal(closesOpenPanel(panel, panel), true)
  assert.equal(closesOpenPanel(undefined, panel), false, 'already closed')
  assert.equal(closesOpenPanel({ from: 5 }, panel), false, 'another panel is open now')
})

test('each Copy button is named by what it copies, and what happened is announced, then reset', () => {
  assert.deepEqual(copyButton('idle', 'Letter'), { text: 'Copy', label: 'Copy: Letter', announce: '', resets: false })
  assert.deepEqual(copyButton('copied', 'Letter'), { text: 'Copied', label: 'Copy: Letter', announce: 'Letter copied', resets: true })
  assert.deepEqual(copyButton('failed', 'Letter'), { text: 'Could not copy', label: 'Copy: Letter', announce: 'Could not copy Letter', resets: true })
})
