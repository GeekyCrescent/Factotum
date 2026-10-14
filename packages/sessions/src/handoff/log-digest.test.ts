import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extendsLog, logDigest } from './log-digest.ts'

const log = (...lines: string[]) => lines.map((line) => `${line}\n`).join('')

test('a log extends the digest of any of its prefixes, and of itself', () => {
  const text = log('a', 'b', 'c')
  assert.equal(extendsLog(text, logDigest(log('a', 'b'))), true)
  assert.equal(extendsLog(text, logDigest(text)), true)
  assert.equal(extendsLog(text, logDigest('')), true)
})

test('a log that went another way, or is shorter, does not', () => {
  assert.equal(extendsLog(log('a', 'x', 'c'), logDigest(log('a', 'b'))), false)
  assert.equal(extendsLog(log('a'), logDigest(log('a', 'b'))), false)
})

test('half a line at the end counts for nothing', () => {
  assert.deepEqual(logDigest(`${log('a', 'b')}{"seq":2,"ki`), logDigest(log('a', 'b')))
  assert.equal(logDigest(log('a', 'b')).lines, 2)
})
