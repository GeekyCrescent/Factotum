import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ago, clip, clock, day, duration, fileName, isToday, previewText, stateLabel, toolArg, shortPath } from './format.ts'

const NOW = Date.parse('2026-09-19T10:00:00.000Z')
const before = (ms: number) => new Date(NOW - ms).toISOString()

test('ago: now, minutes, hours, days, with the clock injected', () => {
  assert.equal(ago(before(20_000), NOW), 'now')
  assert.equal(ago(before(5 * 60_000), NOW), '5m')
  assert.equal(ago(before(3 * 3_600_000), NOW), '3h')
  assert.equal(ago(before(2 * 86_400_000), NOW), '2d')
  assert.equal(ago('garbage', NOW), '')
})

test('duration: seconds, minutes and seconds, hours and minutes; running counts to now', () => {
  assert.equal(duration(before(45_000), undefined, NOW), '45s')
  assert.equal(duration(before(192_000), undefined, NOW), '3m 12s')
  assert.equal(duration(before(3_840_000), new Date(NOW).toISOString(), NOW), '1h 4m')
  assert.equal(duration('garbage', undefined, NOW), '')
})

test('clock is the local hour and minute, two digits each', () => {
  const at = new Date(2026, 8, 19, 9, 5).toISOString()
  assert.equal(clock(at), '09:05')
})

test('isToday compares the local calendar day', () => {
  const now = new Date(2026, 8, 19, 23, 0).getTime()
  assert.equal(isToday(new Date(2026, 8, 19, 0, 1).toISOString(), now), true)
  assert.equal(isToday(new Date(2026, 8, 18, 23, 59).toISOString(), now), false)
})

test('fileName is the last segment of a path, and clip cuts with an ellipsis', () => {
  assert.equal(fileName('/Users/me/Documents/approved.txt'), 'approved.txt')
  assert.equal(fileName('approved.txt'), 'approved.txt')
  assert.equal(clip('abcdef', 4), 'abc…')
  assert.equal(clip('abc', 4), 'abc')
})

test('the preview says WHERE it is cut and by how much, with the end kept (criterion 20)', () => {
  const cut = previewText({ head: 'a'.repeat(1500), tail: 'z'.repeat(500), total: 48_213, edits: null })
  assert.equal(cut.cut, 'showing 2,000 of 48,213 characters')
  assert.equal(cut.tail, 'z'.repeat(500))
  assert.equal(cut.edits, undefined)

  const whole = previewText({ head: 'short', tail: '', total: 5, edits: 3 })
  assert.equal(whole.cut, undefined)
  assert.equal(whole.edits, '3 edits')
  assert.equal(previewText({ head: 'x', tail: '', total: 1, edits: 1 }).edits, '1 edit')
})

test('a tool call shows its most telling argument, and JSON only when there is none', () => {
  assert.equal(toolArg({ file_path: '/a/b.ts', content: 'x' }), '/a/b.ts')
  assert.equal(toolArg({ command: 'pnpm test' }), 'pnpm test')
  assert.equal(toolArg({ pattern: 'TODO', path: 'src' }), 'TODO')
  assert.equal(toolArg({ other: 1 }), '{"other":1}')
  assert.equal(toolArg(undefined), '')
})

test('states read as words', () => {
  assert.deepEqual(['running', 'finished', 'failed', 'cancelled'].map((s) => stateLabel(s as never)), ['Running', 'Finished', 'Failed', 'Cancelled'])
})

test('day: the time today, Yesterday, the day and month this year, and the year before that', () => {
  const now = new Date(2026, 8, 29, 9, 30).getTime()
  assert.equal(day(new Date(2026, 8, 29, 7, 5).toISOString(), now), '07:05')
  assert.equal(day(new Date(2026, 8, 28, 23, 59).toISOString(), now), 'Yesterday')
  assert.equal(day(new Date(2026, 8, 15, 12, 0).toISOString(), now), '15 Sep')
  assert.equal(day(new Date(2025, 11, 31, 12, 0).toISOString(), now), '31 Dec 2025')
})

test('day: yesterday across a month and a year boundary', () => {
  assert.equal(day(new Date(2026, 8, 30, 20, 0).toISOString(), new Date(2026, 9, 1, 8, 0).getTime()), 'Yesterday')
  assert.equal(day(new Date(2025, 11, 31, 20, 0).toISOString(), new Date(2026, 0, 1, 8, 0).getTime()), 'Yesterday')
})

test('day: a date that cannot be read says nothing', () => {
  assert.equal(day('nope', Date.now()), '')
})

test('shortPath writes the home as ~ and cuts a long path in the middle, keeping the folder’s name', () => {
  assert.equal(shortPath('/Users/me/code/web', '/Users/me'), '~/code/web')
  assert.equal(shortPath('/Users/me', '/Users/me'), '~')
  assert.equal(shortPath('/Users/mesa/x', '/Users/me'), '/Users/mesa/x')
  assert.equal(shortPath('/tmp/factotum-proyecto-a', '/Users/me'), '/tmp/factotum-proyecto-a')
  assert.equal(
    shortPath('/Users/me/Ferro/BWR/Projects/AgendamientoMaqueta/MatildeQuirurgico', '/Users/me', 40),
    '~/Ferro/…/MatildeQuirurgico',
  )
})
