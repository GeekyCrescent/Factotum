import { test } from 'node:test'
import assert from 'node:assert/strict'
// Copied with the functions from the sessions module's launch errors (design D9).
import { conflictOf, describe, freshnessOf, launchUnanswered } from './launch-errors.ts'

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

test('describe says what is behind, what is dirty and what the remote warned, joined', () => {
  assert.equal(describe({ clean: false, behind: 2, dirtyFiles: ['a.ts', 'b.ts'] }), '2 commits behind · uncommitted: a.ts, b.ts')
  assert.equal(describe({ clean: true, behind: 1, dirtyFiles: [] }), '1 commit behind')
  assert.equal(describe({ clean: true, behind: 0, dirtyFiles: [], remoteWarning: 'no remote' }), 'no remote')
})

test('a fast-forward that failed travels with the stale 409, and describe says it (spec 2026-10-07-dos-hosts, D5)', () => {
  const freshness = { clean: true, behind: 1, dirtyFiles: [], pullError: 'cannot-fast-forward: fatal: Not possible to fast-forward, aborting.' }
  assert.equal(freshnessOf(failed(409, { freshness }))?.pullError, freshness.pullError)
  assert.equal(describe(freshness), '1 commit behind · cannot-fast-forward: fatal: Not possible to fast-forward, aborting.')
})

test('a 502 to a launch ON ANOTHER HOST is unanswered: it may have started, so it is never retried (design D12, crit. 12)', () => {
  const proxy = failed(502, { error: { code: 'peer-unreachable', message: 'mac did not answer' } })
  assert.equal(launchUnanswered(proxy, 'mac'), true)
  // tailscale serve in plain text says 502 too, with no body.
  assert.equal(launchUnanswered(failed(502, undefined), 'mac'), true)
  // On the serving host a 502 is the daemon not there at all: nothing started, an ordinary error.
  assert.equal(launchUnanswered(proxy, undefined), false)
  assert.equal(launchUnanswered(failed(409, { conflict: { sessionId: 'x' } }), 'mac'), false)
  assert.equal(launchUnanswered(failed(0, undefined), 'mac'), false)
  assert.equal(launchUnanswered(new Error('plain'), 'mac'), false)
})
