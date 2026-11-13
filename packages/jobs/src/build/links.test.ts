import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assertLinearTime } from '../test-support.ts'
import { linksIn } from './links.ts'

test('linksIn: URLs, www. hosts and email addresses, in order, without the sentence’s punctuation', () => {
  const text = 'See https://a.test/x?y=1, then (www.b.test). Mail c.d+e@f.test; or http://g.test/h.'
  assert.deepEqual(linksIn(text), ['https://a.test/x?y=1', 'www.b.test', 'c.d+e@f.test', 'http://g.test/h'])
})

test('linksIn: an address inside a URL is part of the URL; a bare domain is not a link', () => {
  assert.deepEqual(linksIn('https://u@h.test/p and plain.test'), ['https://u@h.test/p'])
})

test('linksIn is linear on hostile input (no ReDoS)', async () => {
  const full = 200_000
  await assertLinearTime('linksIn', full, async (size) => linksIn(`${'a.'.repeat(size / 2)}@${'b-'.repeat(size / 2)} ${'www.'.repeat(size / 4)}`))
})
