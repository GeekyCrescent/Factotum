import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reminderShortcuts } from './reminder-model.ts'

test('S6: with a due date, the due date at 9:00 and the day before at 18:00, as datetime-local values', () => {
  assert.deepEqual(reminderShortcuts('2026-10-16'), [
    { label: 'The due date, 9:00', value: '2026-10-16T09:00' },
    { label: 'The day before, 18:00', value: '2026-10-15T18:00' },
  ])
})

test('the day before crosses months and years', () => {
  assert.equal(reminderShortcuts('2026-11-01')[1]?.value, '2026-10-31T18:00')
  assert.equal(reminderShortcuts('2027-01-01')[1]?.value, '2026-12-31T18:00')
})

test('without a due date, or with one that is not a day, no shortcut: a due date alone never reminds (S6)', () => {
  assert.deepEqual(reminderShortcuts(''), [])
  assert.deepEqual(reminderShortcuts('2026-02-30'), [])
})
