import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DigestEntry } from '../types.ts'
import { dollars, dueText, metaLine, progressText, seconds, sectionsOf, splitFrom, todoOrder, tokens, unsubscribeGroups } from './model.ts'

let counter = 0
function entry(over: Partial<DigestEntry>): DigestEntry {
  counter += 1
  return {
    key: `a:${counter}`,
    messageId: `<${counter}@x>`,
    account: 'Gmail',
    from: 'Ana <ana@example.com>',
    subject: `s${counter}`,
    date: '2026-10-06T07:00:00.000Z',
    link: undefined,
    category: 'action',
    unsubscribeHeader: false,
    attachments: 0,
    seenLastTime: false,
    ...over,
  }
}

test('to-dos: by priority, a missing priority counting as medium (criterion 13)', () => {
  const low = entry({ priority: 'low', subject: 'low' })
  const none = entry({ subject: 'none' })
  const high = entry({ priority: 'high', subject: 'high' })
  const medium = entry({ priority: 'medium', subject: 'medium', date: '2026-10-06T08:00:00.000Z' })
  const spam = entry({ category: 'spam', priority: 'high', subject: 'spam' })
  assert.deepEqual(todoOrder([low, none, spam, high, medium]).map((e) => e.subject), ['high', 'none', 'medium', 'low'])
})

test('to-dos of one priority: the nearest due first, those without one last (criterion 13)', () => {
  const later = entry({ priority: 'high', due: '2026-10-20', subject: 'later' })
  const never = entry({ priority: 'high', subject: 'never' })
  const soon = entry({ priority: 'high', due: '2026-10-08', subject: 'soon' })
  assert.deepEqual(todoOrder([later, never, soon]).map((e) => e.subject), ['soon', 'later', 'never'])
})

test('to-dos of one priority and due: by arrival, the oldest first (criterion 13)', () => {
  const newer = entry({ priority: 'low', date: '2026-10-06T09:00:00.000Z', subject: 'newer' })
  const older = entry({ priority: 'low', date: '2026-10-05T09:00:00.000Z', subject: 'older' })
  assert.deepEqual(todoOrder([newer, older]).map((e) => e.subject), ['older', 'newer'])
})

test('unsubscribes: one row per sender, its count, and whether any carried List-Unsubscribe (criterion 15)', () => {
  const groups = unsubscribeGroups([
    entry({ category: 'unsubscribe', from: 'Shop <news@shop.com>' }),
    entry({ category: 'unsubscribe', from: 'Shop Deals <NEWS@shop.com>', unsubscribeHeader: true }),
    entry({ category: 'unsubscribe', from: 'digest@weekly.io' }),
    entry({ category: 'info', from: 'Shop <news@shop.com>' }),
  ])
  assert.deepEqual(groups, [
    { sender: 'Shop', address: 'news@shop.com', count: 2, hasUnsubscribe: true },
    { sender: 'digest@weekly.io', address: 'digest@weekly.io', count: 1, hasUnsubscribe: false },
  ])
})

test('the sections split by category, unclassified apart', () => {
  const sections = sectionsOf([
    entry({ category: 'spam' }),
    entry({ category: 'info' }),
    entry({ category: 'unclassified' }),
    entry({ category: 'action' }),
  ])
  assert.deepEqual(
    [sections.todo.length, sections.unsubscribe.length, sections.spam.length, sections.info.length, sections.unclassified.length],
    [1, 0, 1, 1, 1],
  )
})

test('the meta line says the sender, the source and "seen last time" (criteria 14, 25); the due date is drawn apart', () => {
  assert.equal(
    metaLine(entry({ from: '"Prof. Ruiz" <ruiz@mq.edu.au>', account: 'Macquarie', due: '2026-10-09', seenLastTime: true })),
    'Prof. Ruiz · Macquarie · seen last time',
  )
  assert.equal(metaLine(entry({ from: 'bare@x.com', account: 'Gmail' })), 'bare@x.com · Gmail')
})

test('the due date, said against today: late and today are urgent, the rest is not (criterion 14)', () => {
  const today = '2026-10-06'
  assert.deepEqual(dueText('2026-10-06', today), { text: 'due today', urgent: true })
  assert.deepEqual(dueText('2026-10-05', today), { text: 'was due yesterday', urgent: true })
  assert.deepEqual(dueText('2026-10-01', today), { text: '5 days late', urgent: true })
  assert.deepEqual(dueText('2026-10-07', today), { text: 'due tomorrow', urgent: false })
  assert.deepEqual(dueText('2026-10-08', today), { text: 'due Thu', urgent: false })
  assert.deepEqual(dueText('2026-10-30', today), { text: 'due Oct 30', urgent: false })
  assert.deepEqual(dueText('2027-01-03', today), { text: 'due Jan 3, 2027', urgent: false })
})

test('a due date that is not YYYY-MM-DD is shown as it came, never as late', () => {
  assert.deepEqual(dueText('next week', '2026-10-06'), { text: 'due next week', urgent: false })
  assert.deepEqual(dueText('2026-13-40', '2026-10-06'), { text: 'due 2026-13-40', urgent: false })
})

test('splitFrom reads a display name, quoted or not, and a bare address', () => {
  assert.deepEqual(splitFrom('"A, B" <A@X.com>'), { name: 'A, B', address: 'a@x.com' })
  assert.deepEqual(splitFrom('A B <a@x.com>'), { name: 'A B', address: 'a@x.com' })
  assert.deepEqual(splitFrom(' a@x.com '), { name: '', address: 'a@x.com' })
})

test('progress, as the screen says it (criterion 18)', () => {
  assert.equal(progressText({ step: 'reading', account: 2, of: 3 }), 'Reading 2 of 3 accounts…')
  assert.equal(progressText({ step: 'reading', account: 1, of: 1 }), 'Reading 1 of 1 account…')
  assert.equal(progressText({ step: 'reading', account: 0, of: 1 }), 'Starting…')
  assert.equal(progressText({ step: 'classifying', batch: 1, of: 2 }), 'Classifying batch 1 of 2…')
  assert.equal(progressText({ step: 'saving' }), 'Saving…')
  assert.equal(progressText(undefined), 'Starting…')
})

test('usage, as the foot says it (criterion 24)', () => {
  assert.equal(tokens(950), '950')
  assert.equal(tokens(41_234), '41.2k')
  assert.equal(seconds(44_600), '45 s')
  assert.equal(seconds(125_000), '2 min 5 s')
  assert.equal(dollars(0.0523), '$0.052')
  assert.equal(dollars(0.229), '$0.23')
})
