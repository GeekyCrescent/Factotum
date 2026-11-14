import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Overview } from './contract.ts'
import { countersOf, startOf } from './tracker-model.ts'

const overview = (over: Partial<Overview> = {}): Overview => ({
  counts: { toReview: 12, approvedNotSent: 3, sent: 20, awaitingReply: 18, interviews: 1, offers: 0 },
  reviewable: 12,
  batchOpen: false,
  batchUndecided: 0,
  missingPhone: false,
  notices: [],
  sends: [],
  ...over,
})

test('the counters of crit. 63, in its order', () => {
  assert.deepEqual(countersOf(overview()), [
    { label: 'To review', value: 12 },
    { label: 'Approved, not sent', value: 3 },
    { label: 'Sent', value: 20 },
    { label: 'Awaiting reply', value: 18 },
    { label: 'Interviews', value: 1 },
    { label: 'Offers', value: 0 },
  ])
})

test('«Start review (N)» arms a batch; with one open it continues it, never arms another over it', () => {
  assert.deepEqual(startOf(overview()), { label: 'Start review (12)', enabled: true, arms: true })
  assert.deepEqual(startOf(overview({ batchOpen: true, batchUndecided: 4 })), { label: 'Continue review', enabled: true, arms: false })
  assert.deepEqual(startOf(overview({ reviewable: 0 })), { label: 'Start review (0)', enabled: false, arms: true })
})

test('a finished batch (open, nothing undecided) offers a new one of what is left — blocked ones too — never «Continue review» (R8)', () => {
  assert.deepEqual(startOf(overview({ batchOpen: true, batchUndecided: 0, reviewable: 3 })), { label: 'Start review (3)', enabled: true, arms: true })
  assert.deepEqual(startOf(overview({ batchOpen: true, batchUndecided: 0, reviewable: 0 })), { label: 'Start review (0)', enabled: false, arms: true })
})
