import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BatchView, ItemResult, ReviewItem } from './contract.ts'
import { SETTLE_MS, canDecide, confirmedLocal, createLock, decisionOn, localResultOf, settleLeft, viewOf, withLocal } from './guard.ts'

// ── What was seen is what is approved (D15 «Lo que se vio es lo que se aprueba») ─────────────────

test('a card just shown refuses Approve and Skip for SETTLE_MS', () => {
  const shownAt = 10_000
  assert.equal(SETTLE_MS, 700)
  assert.equal(canDecide(shownAt, shownAt), false)
  assert.equal(canDecide(shownAt, shownAt + SETTLE_MS - 1), false)
  assert.equal(canDecide(shownAt, shownAt + SETTLE_MS), true)
  assert.equal(canDecide(shownAt, shownAt + 5_000), true)
})

test('a clock that went backwards does not unlock the card', () => {
  assert.equal(canDecide(10_000, 9_000), false)
})

test('settleLeft says how long until the card takes a decision', () => {
  assert.equal(settleLeft(1_000, 1_000), SETTLE_MS)
  assert.equal(settleLeft(1_000, 1_500), 200)
  assert.equal(settleLeft(1_000, 9_000), 0)
})

// ── One decision in flight ───────────────────────────────────────────────────────────────────────

test('a second decision in the same frame is refused while the first is in flight', async () => {
  const lock = createLock()
  let release: (value: string) => void = () => undefined
  const first = lock.run(() => new Promise<string>((resolve) => (release = resolve)))
  const second = lock.run(async () => 'second')
  assert.notEqual(first, null)
  assert.equal(second, null)
  assert.equal(lock.held(), true)
  release('first')
  assert.equal(await first, 'first')
  assert.equal(lock.held(), false)
  assert.equal(await lock.run(async () => 'third'), 'third')
})

test('a decision that throws still releases the lock, and the error reaches the caller', async () => {
  const lock = createLock()
  await assert.rejects(lock.run(async () => Promise.reject(new Error('boom'))) ?? Promise.resolve(), /boom/)
  assert.equal(lock.held(), false)
})

test('a callback that throws synchronously still releases the lock', async () => {
  const lock = createLock()
  await assert.rejects(lock.run(() => { throw new Error('sync') }) ?? Promise.resolve(), /sync/)
  assert.equal(lock.held(), false)
})

// ── The card that was seen (`seen`, D15) ─────────────────────────────────────────────────────────

const proposal = (seen: string, itemId = 'i-1'): ReviewItem => ({ itemId, seen, kind: 'proposal', proposalId: 'p' })

test('the view changes with the item AND with what its card shows', () => {
  assert.equal(viewOf(proposal('v1')), viewOf(proposal('v1')))
  assert.notEqual(viewOf(proposal('v1')), viewOf(proposal('v2')))
  assert.notEqual(viewOf(proposal('v1', 'i-1')), viewOf(proposal('v1', 'i-2')))
  assert.equal(viewOf(undefined), '')
})

test('every decision carries the item and the seen of the card on screen', () => {
  assert.deepEqual(decisionOn(proposal('v7'), { kind: 'approve' }), { kind: 'approve', itemId: 'i-1', seen: 'v7' })
  assert.deepEqual(decisionOn(proposal('v7'), { kind: 'skip', reason: 'not-now' }), { kind: 'skip', reason: 'not-now', itemId: 'i-1', seen: 'v7' })
})

// ── Decided here, not yet read back ──────────────────────────────────────────────────────────────

const batchOf = (results: Readonly<Record<string, ItemResult>>, ids = ['i-1', 'i-2', 'i-3']): BatchView => ({
  id: 'b-1',
  test: false,
  items: ids.map((id) => proposal('v1', id)),
  cursor: 0,
  results,
  rewriting: 0,
})

test('a decision that went through is a local result: approve, skip, instruct; the rest decide nothing', () => {
  assert.equal(localResultOf('approve'), 'approved')
  assert.equal(localResultOf('skip'), 'skipped')
  assert.equal(localResultOf('instruct'), 'instructed')
  assert.equal(localResultOf('override'), null)
  assert.equal(localResultOf('switch-to-form'), null)
  assert.equal(localResultOf('switch-channel'), null)
})

test('a stale read never offers again an item decided here', () => {
  const stale = batchOf({})
  const view = withLocal(stale, new Map([['i-1', 'approved']]))
  assert.deepEqual(view.results, { 'i-1': 'approved' })
  assert.notEqual(view, stale)
})

test('the daemon\'s result wins over the local one, and no local results leave the batch as it is', () => {
  const batch = batchOf({ 'i-1': 'sent' })
  assert.deepEqual(withLocal(batch, new Map([['i-1', 'approved']])).results, { 'i-1': 'sent' })
  assert.equal(withLocal(batch, new Map()), batch)
})

test('a local result goes once a read confirms it, or once its item is no longer in the batch', () => {
  const local: ReadonlyMap<string, ItemResult> = new Map([
    ['i-1', 'approved'],
    ['i-2', 'skipped'],
    ['gone', 'approved'],
  ])
  const pruned = confirmedLocal(local, batchOf({ 'i-1': 'approved' }))
  assert.deepEqual([...pruned.keys()], ['i-2'])
  assert.equal(local.size, 3, 'the map given is not changed')
})

test('nothing to prune gives back the same map', () => {
  const local: ReadonlyMap<string, ItemResult> = new Map([['i-2', 'skipped']])
  assert.equal(confirmedLocal(local, batchOf({})), local)
})
