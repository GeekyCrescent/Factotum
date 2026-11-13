import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { APP_STATES, FOLLOWUP_STATES } from '../types.ts'
import {
  appendReturned,
  buildBatch,
  pendingRewrites,
  pruneBatch,
  skippedOn,
  type AppCandidate,
  type Batch,
  type FollowupCandidate,
  type Pool,
  type ReviewItemRef,
  type ReviewMark,
} from './batch.ts'

const TODAY = '2026-11-14'
const TZ = 'Australia/Sydney'
/** 2026-11-14 midday in Sydney. */
const AT_TODAY = '2026-11-14T01:00:00.000Z'
/** 2026-11-13 in Sydney. */
const AT_YESTERDAY = '2026-11-12T23:00:00.000Z'

function ids(): () => string {
  let n = 0
  return () => `item-${(n += 1)}`
}

const app = (id: string, overrides: Partial<AppCandidate> = {}): AppCandidate => ({
  id,
  state: 'ready',
  score: null,
  holdUntil: null,
  test: false,
  version: 1,
  ...overrides,
})

const fu = (id: string, overrides: Partial<FollowupCandidate> = {}): FollowupCandidate => ({ id, state: 'ready', version: 1, ...overrides })

const pool = (overrides: Partial<Pool> = {}): Pool => ({ applications: [], followups: [], proposals: [], replies: [], marks: [], ...overrides })

const mark = (overrides: Partial<ReviewMark> & Pick<ReviewMark, 'kind'>): ReviewMark => ({
  applicationId: 'a1',
  followupId: null,
  at: AT_TODAY,
  data: {},
  ...overrides,
})

const build = (p: Pool, batchSize = 10): readonly ReviewItemRef[] => buildBatch(p, { today: TODAY, timeZone: TZ, batchSize, newId: ids() })

/** What an item points to, without its itemId. */
const what = (item: ReviewItemRef): string => {
  switch (item.kind) {
    case 'application':
      return `application:${item.applicationId}`
    case 'followup':
      return `followup:${item.followupId}`
    case 'proposal':
      return `proposal:${item.proposalId}`
    case 'reply':
      return `reply:${item.eventId}`
    case 'rewritten':
      return `rewritten:${item.id}${item.failed ? ':failed' : ''}`
  }
}

describe('buildBatch — what enters (design D15 «Qué entra al lote»)', () => {
  for (const state of APP_STATES) {
    const enters = state === 'in-review' || state === 'ready'
    test(`an application in ${state} ${enters ? 'enters' : 'does not enter'}`, () => {
      assert.deepEqual(build(pool({ applications: [app('a1', { state })] })).map(what), enters ? ['application:a1'] : [])
    })
  }

  for (const state of FOLLOWUP_STATES) {
    const enters = state === 'draft' || state === 'ready'
    test(`a follow-up in ${state} ${enters ? 'enters' : 'does not enter'}`, () => {
      assert.deepEqual(build(pool({ followups: [fu('f1', { state })] })).map(what), enters ? ['followup:f1'] : [])
    })
  }

  test('a held application enters on its day, not before', () => {
    const p = pool({ applications: [app('later', { holdUntil: '2026-11-15' }), app('today', { holdUntil: TODAY }), app('past', { holdUntil: '2026-01-01' })] })
    assert.deepEqual(build(p).map(what), ['application:today', 'application:past'])
  })

  test('what was skipped today stays out; what was skipped yesterday is back', () => {
    const p = pool({
      applications: [app('a1'), app('a2')],
      followups: [fu('f1'), fu('f2')],
      marks: [
        mark({ kind: 'skipped', applicationId: 'a1', at: AT_TODAY }),
        mark({ kind: 'skipped', applicationId: 'a2', at: AT_YESTERDAY }),
        mark({ kind: 'skipped', applicationId: 'a9', followupId: 'f1', at: AT_TODAY }),
      ],
    })
    assert.deepEqual(build(p).map(what), ['followup:f2', 'application:a2'])
  })

  test('the test application never enters a normal batch', () => {
    const p = pool({ applications: [app('t1', { test: true, state: 'sent' }), app('a1')] })
    assert.deepEqual(build(p).map(what), ['application:a1'])
  })

  test('while the test application is in-review or ready, the batch is only it', () => {
    const p = pool({ applications: [app('a1'), app('t1', { test: true, state: 'in-review' })], followups: [fu('f1')], proposals: ['p1'] })
    assert.deepEqual(build(p).map(what), ['application:t1'])
  })
})

describe('buildBatch — the order of R28', () => {
  test('asks, rewrites, follow-ups, proposals, ready by score, then in-review by score', () => {
    const p = pool({
      applications: [
        app('blocked-low', { state: 'in-review', score: 20 }),
        app('ready-none', { score: null }),
        app('ready-high', { score: 90 }),
        app('blocked-high', { state: 'in-review', score: 80 }),
        app('ready-mid', { score: 50 }),
        app('rewrote', { state: 'ready', score: 99, version: 3 }),
      ],
      followups: [fu('f1', { state: 'draft' }), fu('f2')],
      proposals: ['p1'],
      replies: [{ applicationId: 'x', eventId: 'e1' }],
      marks: [mark({ kind: 'instruction', applicationId: 'rewrote' }), mark({ kind: 'rewritten', applicationId: 'rewrote', data: { version: 3 } })],
    })
    assert.deepEqual(build(p).map(what), [
      'reply:e1',
      'rewritten:rewrote',
      'followup:f1',
      'followup:f2',
      'proposal:p1',
      'application:ready-high',
      'application:ready-mid',
      'application:ready-none',
      'application:blocked-high',
      'application:blocked-low',
    ])
  })

  test('a rewritten item names its target, the version it came from, and whether it failed', () => {
    const p = pool({
      applications: [app('ok', { version: 3 }), app('ko', { state: 'in-review', version: 2 })],
      followups: [fu('f1', { version: 4 })],
      marks: [
        mark({ kind: 'rewritten', applicationId: 'ok', data: { version: 3 } }),
        mark({ kind: 'rewrite-failed', applicationId: 'ko', data: { instruction: 'shorter' } }),
        mark({ kind: 'rewritten', applicationId: 'a9', followupId: 'f1', data: { version: 4 } }),
      ],
    })
    const items = build(p).map(({ itemId: _, ...rest }) => rest)
    assert.deepEqual(items, [
      { kind: 'rewritten', target: 'application', id: 'ok', fromVersion: 2, failed: false },
      { kind: 'rewritten', target: 'application', id: 'ko', fromVersion: 2, failed: true },
      { kind: 'rewritten', target: 'followup', id: 'f1', fromVersion: 3, failed: false },
    ])
  })

  test('80 applications blocked by missing-portfolio make a batch of 10, all in-review', () => {
    const blocked = Array.from({ length: 80 }, (_, i) => app(`a${i}`, { state: 'in-review', score: i }))
    const items = build(pool({ applications: blocked }), 10)
    assert.equal(items.length, 10)
    assert.deepEqual(
      items.map(what),
      Array.from({ length: 10 }, (_, i) => `application:a${79 - i}`),
    )
  })

  test('every item gets its own id', () => {
    const items = build(pool({ applications: [app('a1'), app('a2')], followups: [fu('f1')] }))
    assert.deepEqual(
      items.map((i) => i.itemId),
      ['item-1', 'item-2', 'item-3'],
    )
  })
})

describe('pendingRewrites and skippedOn', () => {
  test('a rewrite stays pending until a decision follows it', () => {
    const marks = [
      mark({ kind: 'instruction' }),
      mark({ kind: 'rewritten', data: { version: 2 } }),
      mark({ kind: 'instruction', applicationId: 'a2' }),
      mark({ kind: 'rewrite-failed', applicationId: 'a2' }),
      mark({ kind: 'approved', applicationId: 'a2' }),
    ]
    assert.deepEqual(pendingRewrites(marks), [{ target: 'application', id: 'a1', version: 2, failed: false }])
  })

  test('a rewritten event without a version is a version of null', () => {
    assert.deepEqual(pendingRewrites([mark({ kind: 'rewritten', data: { version: 'two' } })]), [{ target: 'application', id: 'a1', version: null, failed: false }])
  })

  test('skippedOn reads the day in the zone', () => {
    const marks = [mark({ kind: 'skipped', applicationId: 'a1', at: AT_TODAY }), mark({ kind: 'skipped', applicationId: 'a2', at: AT_YESTERDAY })]
    assert.deepEqual([...skippedOn(marks, TODAY, TZ)], ['a1'])
  })
})

const batchOf = (items: readonly ReviewItemRef[], overrides: Partial<Batch> = {}): Batch => ({ id: 'b1', items, cursor: 0, results: {}, ...overrides })
const appItem = (itemId: string, applicationId: string): ReviewItemRef => ({ itemId, kind: 'application', applicationId })

describe('pruneBatch — what leaves the open batch', () => {
  test('an undecided item whose entity left a batch state leaves; the cursor keeps its item', () => {
    const batch = batchOf([appItem('i1', 'a1'), appItem('i2', 'a2'), appItem('i3', 'a3'), appItem('i4', 'a4')], { cursor: 2, results: { i1: 'approved' } })
    const pruned = pruneBatch(batch, (item) => item.kind === 'application' && item.applicationId !== 'a2' && item.applicationId !== 'a1')
    assert.deepEqual(
      pruned.items.map((i) => i.itemId),
      ['i1', 'i3', 'i4'],
    )
    assert.equal(pruned.cursor, 1)
    assert.deepEqual(pruned.results, { i1: 'approved' })
  })

  test('nothing left: the same batch back', () => {
    const batch = batchOf([appItem('i1', 'a1')])
    assert.equal(pruneBatch(batch, () => true), batch)
  })
})

describe('appendReturned — a rewrite that comes back goes to the end', () => {
  test('appended once, failed or not; an undecided item of the same entity gives way', () => {
    const batch = batchOf([appItem('i1', 'a1'), appItem('i2', 'a2'), appItem('i3', 'a3')], { cursor: 2, results: { i1: 'instructed' } })
    const returned = [
      { target: 'application', id: 'a1', version: 2, failed: false },
      { target: 'application', id: 'a2', version: null, failed: true },
    ] as const
    const once = appendReturned(batch, returned, { a1: 1, a2: 5 }, ids())
    assert.deepEqual(once.items.map(what), ['application:a1', 'application:a3', 'rewritten:a1', 'rewritten:a2:failed'])
    assert.equal(once.cursor, 1)
    const fromVersions = once.items.filter((i) => i.kind === 'rewritten').map((i) => (i.kind === 'rewritten' ? i.fromVersion : -1))
    assert.deepEqual(fromVersions, [1, 5])
    const twice = appendReturned(once, returned, { a1: 1, a2: 5 }, ids())
    assert.equal(twice, once)
  })
})
