import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grantTokenFrom } from './grant-token.ts'

const TOKEN = 'b'.repeat(43)

test('a well-formed ?grant= is read; anything else is not ours', () => {
  assert.equal(grantTokenFrom(`?grant=${TOKEN}`), TOKEN)
  assert.equal(grantTokenFrom(`?x=1&grant=${TOKEN}`), TOKEN)
  for (const search of ['', '?grant=', '?grant=short', `?ask=${TOKEN}`, `?grant=${TOKEN}!`]) {
    assert.equal(grantTokenFrom(search), undefined, search)
  }
})
