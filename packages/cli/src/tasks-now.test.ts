import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tasksNowOffset } from './tasks-now.ts'

const DAY_MS = 24 * 60 * 60 * 1000

function run(env: string, value: string | undefined) {
  const warnings: string[] = []
  const offset = tasksNowOffset(env, { FACTOTUM_TASKS_NOW_OFFSET_DAYS: value }, (m) => warnings.push(m))
  return { offset, warnings }
}

test('in dev, the variable moves the board’s clock by whole days', () => {
  assert.deepEqual(run('dev', '7'), { offset: 7 * DAY_MS, warnings: [] })
  assert.deepEqual(run('dev', '-3'), { offset: -3 * DAY_MS, warnings: [] })
})

test('in dev without the variable, the clock is the kernel’s', () => {
  assert.deepEqual(run('dev', undefined), { offset: 0, warnings: [] })
})

test('in dev, a value that is not a whole number of days, or past a year, is ignored with a warning', () => {
  for (const value of ['abc', '1.5', '', '7d', '400', '-400']) {
    const { offset, warnings } = run('dev', value)
    assert.equal(offset, 0, value)
    assert.equal(warnings.length, 1, value)
    assert.match(warnings[0] ?? '', /FACTOTUM_TASKS_NOW_OFFSET_DAYS/)
  }
})

test('in prod it is ignored, and said only when it is set', () => {
  const set = run('prod', '7')
  assert.equal(set.offset, 0)
  assert.equal(set.warnings.length, 1)
  assert.match(set.warnings[0] ?? '', /only read in dev/)
  assert.deepEqual(run('prod', undefined), { offset: 0, warnings: [] })
})
