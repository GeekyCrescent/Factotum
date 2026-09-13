import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prefixed } from './log.ts'

function fakeConsole(): { lines: string[]; sink: Console } {
  const lines: string[] = []
  const sink = { error: (line: string) => lines.push(line) } as unknown as Console
  return { lines, sink }
}

test('every line carries the prefix', () => {
  const { lines, sink } = fakeConsole()
  const log = prefixed('example', sink)

  log.info('started')
  log.warn('slow')
  log.error('broke')

  assert.deepEqual(lines, ['[example] started', '[example] slow', '[example] broke'])
})

test('writes to stderr so stdout stays usable for real output', () => {
  // The QR and the URL go to stdout; logs must not interleave with them.
  const { lines, sink } = fakeConsole()
  prefixed('factotum', sink).info('x')
  assert.equal(lines.length, 1)
})
