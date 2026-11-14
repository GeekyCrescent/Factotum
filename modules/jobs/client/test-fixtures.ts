/**
 * Cards for the client's tests: one place, so a field added to the contract is added here once.
 * Not a test itself; imported by the `*.test.ts` files.
 */

import type { Address, ApplicationCard, FollowupCard, ReviewItem, RewriteInfo } from './contract.ts'

export const TODAY = '2026-11-13T08:00:00.000Z'

export const address = (over: Partial<Address> = {}): Address => ({ status: 'verified', verifiedUrl: 'https://acme.io', checkedAt: TODAY, override: null, ...over })

const IDLE = { state: 'idle', reason: null } as const

export function application(over: Partial<ApplicationCard> = {}): ApplicationCard {
  return {
    id: 'app-1',
    state: 'ready',
    channel: 'email',
    test: false,
    version: 2,
    company: { id: 'c-1', name: 'Acme' },
    role: 'Developer',
    hours: 'part-time',
    score: 82,
    adUrl: 'https://acme.io/job',
    formUrl: 'https://acme.io/apply',
    contact: { id: 'k-1', name: 'Sean', email: 'sean@acme.io', address: address() },
    to: 'sean@acme.io',
    letter: { subject: 'Hello', body: 'Hi Sean' },
    form: [],
    linkedin: null,
    cv: { base: 'B', png: 'a/app-1/v/2/preview.png', pdf: 'a/app-1/v/2/cv.pdf', tailored: null },
    notes: '',
    warnings: [],
    jobs: { cv: IDLE, letter: IDLE, reprint: IDLE },
    sends: [],
    ...over,
  }
}

export function followup(over: Partial<FollowupCard> = {}): FollowupCard {
  return {
    id: 'f-1',
    applicationId: 'app-1',
    n: 1,
    state: 'ready',
    channel: 'email',
    company: { id: 'c-1', name: 'Acme' },
    role: 'Developer',
    contact: { id: 'k-1', name: 'Sean', email: 'sean@acme.io', address: address() },
    to: 'sean@acme.io',
    subject: 'Following up',
    body: 'Hi again',
    warnings: [],
    ...over,
  }
}

export const rewrite = (over: Partial<RewriteInfo> = {}): RewriteInfo => ({
  fromVersion: 1,
  failed: false,
  instruction: 'make it shorter',
  reason: null,
  before: 'Hi Sean, a long letter',
  ...over,
})

export const appItem = (over: Partial<ApplicationCard> = {}, itemId = 'i-1'): ReviewItem => ({ itemId, seen: 's1', kind: 'application', application: application(over) })
