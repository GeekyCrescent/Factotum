import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareCycles, cycleOf, cyclesBetween, isCycleId, localDate, nextCycle, rangeOf } from './cycle.ts'

const SYDNEY = 'Australia/Sydney'
const at = (iso: string): Date => new Date(iso)

// --- cycleOf: the ISO week of a moment, in the board's zone ---------------------------------

test('Sunday 23:59 and Monday 00:00 in Sydney are two cycles, though UTC says Sunday for both', () => {
  // AEDT is +11: Monday 2026-10-12 00:00 local is 2026-10-11 13:00 UTC.
  assert.equal(cycleOf(at('2026-10-11T12:59:00Z'), SYDNEY), '2026-W41')
  assert.equal(cycleOf(at('2026-10-11T13:00:00Z'), SYDNEY), '2026-W42')
  assert.equal(cycleOf(at('2026-10-11T13:00:00Z'), 'UTC'), '2026-W41')
})

test('the end of daylight saving in Sydney (2026-04-05, back to +10) moves the Monday boundary', () => {
  assert.equal(cycleOf(at('2026-04-05T13:59:00Z'), SYDNEY), '2026-W14')
  assert.equal(cycleOf(at('2026-04-05T14:00:00Z'), SYDNEY), '2026-W15')
})

test('the start of daylight saving in Sydney (2026-10-04, on to +11) moves it back', () => {
  assert.equal(cycleOf(at('2026-10-04T12:59:00Z'), SYDNEY), '2026-W40')
  assert.equal(cycleOf(at('2026-10-04T13:00:00Z'), SYDNEY), '2026-W41')
})

test('the ISO year: 2026 has 53 weeks, and 29 Dec 2025 is already 2026-W01', () => {
  assert.equal(cycleOf(at('2025-12-28T12:00:00Z'), 'UTC'), '2025-W52')
  assert.equal(cycleOf(at('2025-12-29T12:00:00Z'), 'UTC'), '2026-W01')
  assert.equal(cycleOf(at('2026-12-28T12:00:00Z'), 'UTC'), '2026-W53')
  for (const day of ['2027-01-01', '2027-01-02', '2027-01-03']) {
    assert.equal(cycleOf(at(`${day}T12:00:00Z`), 'UTC'), '2026-W53', day)
  }
  assert.equal(cycleOf(at('2027-01-04T12:00:00Z'), 'UTC'), '2027-W01')
})

test('the week always has two digits', () => {
  assert.equal(cycleOf(at('2026-03-02T12:00:00Z'), 'UTC'), '2026-W10')
  assert.equal(cycleOf(at('2026-02-25T12:00:00Z'), 'UTC'), '2026-W09')
  assert.equal(cycleOf(at('2026-01-01T12:00:00Z'), 'UTC'), '2026-W01')
})

test('a cycle id without its padding is not a cycle id', () => {
  assert.equal(isCycleId('2026-W09'), true)
  assert.equal(isCycleId('2026-W53'), true)
  for (const bad of ['2026-W9', '2026-W00', '2026-W54', '2026W09', '26-W09', ' 2026-W09']) assert.equal(isCycleId(bad), false, bad)
})

// --- compareCycles: numbers, never text -----------------------------------------------------

test('compareCycles compares year and week as numbers (criterion 14)', () => {
  assert.equal(compareCycles('2026-W09', '2026-W10'), -1)
  assert.equal(compareCycles('2026-W10', '2026-W09'), 1)
  assert.equal(compareCycles('2026-W52', '2027-W01'), -1)
  assert.equal(compareCycles('2027-W01', '2026-W52'), 1)
  assert.equal(compareCycles('2026-W42', '2026-W42'), 0)
})

test('compareCycles refuses something that is not a cycle id rather than guessing', () => {
  assert.throws(() => compareCycles('2026-W9', '2026-W10'))
})

// --- nextCycle and cyclesBetween ------------------------------------------------------------

test('nextCycle crosses a 53-week year and a 52-week one', () => {
  assert.equal(nextCycle('2026-W41'), '2026-W42')
  assert.equal(nextCycle('2026-W52'), '2026-W53')
  assert.equal(nextCycle('2026-W53'), '2027-W01')
  assert.equal(nextCycle('2027-W52'), '2028-W01')
})

test('cyclesBetween lists every cycle from the first up to, not including, the second', () => {
  assert.deepEqual(cyclesBetween('2026-W40', '2026-W43'), ['2026-W40', '2026-W41', '2026-W42'])
  assert.deepEqual(cyclesBetween('2026-W52', '2027-W02'), ['2026-W52', '2026-W53', '2027-W01'])
  assert.deepEqual(cyclesBetween('2026-W42', '2026-W42'), [])
  assert.deepEqual(cyclesBetween('2026-W43', '2026-W42'), [])
})

// --- the dates around a cycle ---------------------------------------------------------------

test('rangeOf gives the Monday and the Sunday of a cycle', () => {
  assert.deepEqual(rangeOf('2026-W42'), { start: '2026-10-12', end: '2026-10-18' })
  assert.deepEqual(rangeOf('2026-W01'), { start: '2025-12-29', end: '2026-01-04' })
  assert.deepEqual(rangeOf('2026-W53'), { start: '2026-12-28', end: '2027-01-03' })
})

test('localDate is the calendar day in the zone, not in UTC', () => {
  assert.equal(localDate(at('2026-10-11T13:00:00Z'), SYDNEY), '2026-10-12')
  assert.equal(localDate(at('2026-10-11T13:00:00Z'), 'UTC'), '2026-10-11')
})
