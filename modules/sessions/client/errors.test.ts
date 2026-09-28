import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conflictOf, describe, freshnessOf, messageOf } from './errors.ts'

/** What `apps/web/src/api.ts` throws: an ordinary Error with the status and the body on it. */
const failed = (status: number, body: unknown) => Object.assign(new Error(`${status}`), { status, body })

test('a 409 with a conflict names the session that holds the site (criterion 19)', () => {
  assert.deepEqual(conflictOf(failed(409, { conflict: { sessionId: '019a' } })), { sessionId: '019a' })
  assert.equal(conflictOf(failed(409, { freshness: { clean: true, behind: 1, dirtyFiles: [] } })), undefined)
  assert.equal(conflictOf(failed(500, { conflict: { sessionId: '019a' } })), undefined, 'only a 409')
  assert.equal(conflictOf(new Error('plain')), undefined)
  assert.equal(conflictOf(undefined), undefined)
})

test('a 409 with freshness is the stale case, and nothing else is', () => {
  const freshness = { clean: false, behind: 2, dirtyFiles: ['a.ts'] }
  assert.deepEqual(freshnessOf(failed(409, { freshness })), freshness)
  assert.equal(freshnessOf(failed(409, { conflict: { sessionId: 'x' } })), undefined)
  assert.equal(freshnessOf(failed(400, { freshness })), undefined)
})

test('the message of an Error, or the thing itself in words', () => {
  assert.equal(messageOf(new Error('the daemon said no')), 'the daemon said no')
  assert.equal(messageOf('text'), 'text')
})

test('describe says what is behind, what is dirty and what the remote warned, joined', () => {
  assert.equal(describe({ clean: false, behind: 2, dirtyFiles: ['a.ts', 'b.ts'] }), '2 commits behind · uncommitted: a.ts, b.ts')
  assert.equal(describe({ clean: true, behind: 1, dirtyFiles: [] }), '1 commit behind')
  assert.equal(describe({ clean: true, behind: 0, dirtyFiles: [], remoteWarning: 'no remote' }), 'no remote')
})
