/**
 * Weekly cycles: the ISO week of a moment in the board's time zone (spec 2026-10-14, design D4).
 *
 * PURE, AND WITHOUT A DEPENDENCY. `Intl` turns the moment into the calendar day of the zone, and
 * the ISO arithmetic runs on that day as a UTC date — where every day has 24 hours, so a change of
 * daylight saving cannot shift it.
 *
 * TWO CYCLES ARE COMPARED ONLY WITH `compareCycles`. The text happens to sort while the week has two
 * digits, and that is exactly the kind of accident that stops being true the day somebody writes
 * `2026-W9` (criterion 14).
 */

import type { CycleId, CycleRange } from './types.ts'

/** `YYYY-Www`, the week ALWAYS with two digits: `2026-W9` is not a cycle (criterion 14). */
export const CYCLE_ID_PATTERN = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/

const DAY_MS = 24 * 60 * 60 * 1000

/** One formatter per zone: building one costs more than formatting with it. */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const known = formatters.get(timeZone)
  if (known !== undefined) return known
  const made = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  formatters.set(timeZone, made)
  return made
}

export function isCycleId(value: string): boolean {
  return CYCLE_ID_PATTERN.test(value)
}

/** The calendar day of `now` in `timeZone`, `YYYY-MM-DD`. */
export function localDate(now: Date, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(now)
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** A `YYYY-MM-DD` as midnight UTC: a date with no zone left in it. */
function utcDay(date: string): Date {
  return new Date(`${date}T00:00:00Z`)
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** ISO week of a day held as a UTC date: the year and week of its Thursday. */
function weekOfDay(day: Date): CycleId {
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay()
  const thursday = new Date(day.getTime() + (4 - weekday) * DAY_MS)
  const year = thursday.getUTCFullYear()
  const dayOfYear = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS)
  const week = Math.floor(dayOfYear / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

export function cycleOf(now: Date, timeZone: string): CycleId {
  return weekOfDay(utcDay(localDate(now, timeZone)))
}

function parse(id: CycleId): { readonly year: number; readonly week: number } {
  if (!isCycleId(id)) throw new Error('not a cycle id')
  return { year: Number(id.slice(0, 4)), week: Number(id.slice(6)) }
}

/** The Monday of a cycle: 4 January is always in week 1. */
function mondayOf(id: CycleId): Date {
  const { year, week } = parse(id)
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Weekday = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay()
  return new Date(jan4.getTime() + ((week - 1) * 7 - (jan4Weekday - 1)) * DAY_MS)
}

export function compareCycles(a: CycleId, b: CycleId): -1 | 0 | 1 {
  const left = parse(a)
  const right = parse(b)
  const delta = left.year === right.year ? left.week - right.week : left.year - right.year
  return delta < 0 ? -1 : delta > 0 ? 1 : 0
}

export function nextCycle(id: CycleId): CycleId {
  return weekOfDay(new Date(mondayOf(id).getTime() + 7 * DAY_MS))
}

/** Every cycle from `from` up to, NOT including, `to`: the ones a close archives (design D4). */
export function cyclesBetween(from: CycleId, to: CycleId): readonly CycleId[] {
  const out: CycleId[] = []
  for (let cycle = from; compareCycles(cycle, to) < 0; cycle = nextCycle(cycle)) out.push(cycle)
  return out
}

/** Monday and Sunday of a cycle, for the header «W42 · 12–18 Oct». */
export function rangeOf(id: CycleId): CycleRange {
  const monday = mondayOf(id)
  return { start: isoDay(monday), end: isoDay(new Date(monday.getTime() + 6 * DAY_MS)) }
}
