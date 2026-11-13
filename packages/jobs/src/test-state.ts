/**
 * Fixtures of the state machine (design D3), shared by `state*.test.ts` and `store/repo.test.ts`.
 * Excluded from coverage (`src/test-*.ts`).
 *
 * THE SEVEN ADDRESS FIXTURES are the rows of «Qué responde el motor» (v5, X4), by name: tasks B5, E2
 * and N4 use these and no others.
 */

import assert from 'node:assert/strict'
import type { Address, Application, Contact, Followup, FollowupVersion, Result, Send, Warning } from './types.ts'

export const NOW = new Date('2026-11-14T00:00:00.000Z')
/** A check that finished today. */
export const TODAY = '2026-11-13T21:00:00.000Z'
/** A check of fifteen days ago: stale (`ADDRESS_STALE_DAYS = 14`). */
export const FIFTEEN_DAYS_AGO = '2026-10-30T00:00:00.000Z'
export const CREATED = '2026-11-10T00:00:00.000Z'
export const CAP = { sentToday: 0, maxPerDay: 40 } as const

export const ADDRESSES = {
  verifiedToday: { status: 'verified', verifiedUrl: 'https://acme.example/contact', checkedAt: TODAY, override: null },
  verifiedStale: { status: 'verified', verifiedUrl: 'https://acme.example/contact', checkedAt: FIFTEEN_DAYS_AGO, override: null },
  checking: { status: 'checking', verifiedUrl: null, checkedAt: null, override: null },
  unverifiedNeverChecked: { status: 'unverified', verifiedUrl: null, checkedAt: null, override: null },
  unverifiedToday: { status: 'unverified', verifiedUrl: null, checkedAt: TODAY, override: null },
  unverifiedTodayOverride: { status: 'unverified', verifiedUrl: null, checkedAt: TODAY, override: { at: TODAY } },
  unverifiedStaleOverride: { status: 'unverified', verifiedUrl: null, checkedAt: FIFTEEN_DAYS_AGO, override: { at: FIFTEEN_DAYS_AGO } },
} as const satisfies Record<string, Address>

export const BLOCKER: Warning = { code: 'placeholder', where: 'letter', detail: '[x] in the letter', blocks: true, overridden: null }
export const ADVISORY: Warning = { code: 'too-long', where: 'letter', detail: 'letter 240 words', blocks: false, overridden: null }
export const OVERRIDDEN: Warning = { code: 'unsupported-claim', where: 'cv', detail: 'claim', blocks: true, overridden: { at: TODAY } }

export function contact(address: Address | null, overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    companyId: 'company-1',
    name: 'Ada Lovelace',
    role: 'CTO',
    email: address === null ? null : 'ada@acme.example',
    sourceUrl: null,
    address,
    ...overrides,
  }
}

export function send(overrides: Partial<Send> = {}): Send {
  return {
    kind: 'initial',
    followupId: null,
    channel: 'smtp',
    messageId: '<m1@jobs.factotum.local>',
    state: 'sending',
    at: CREATED,
    response: null,
    reason: null,
    addressOverride: false,
    profileVersion: 1,
    artifactsVersion: 1,
    attempts: [],
    ...overrides,
  }
}

export function application(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    opportunityId: 'opp-1',
    companyId: 'company-1',
    channel: 'email',
    target: { contactId: 'contact-1', to: 'ada@acme.example', url: null, contactName: 'Ada Lovelace', instruction: null },
    cvBase: 'A',
    state: 'ready',
    outcome: null,
    rewriteFrom: null,
    holdUntil: null,
    version: 1,
    sends: [],
    notes: '',
    test: false,
    warnings: [],
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  }
}

export function followupVersion(version: number, overrides: Partial<FollowupVersion> = {}): FollowupVersion {
  return {
    version,
    subject: null,
    body: 'Hi {greetingName},\n\nFollowing up.\n\n{signature}',
    origin: 'template',
    instruction: null,
    profileVersion: 1,
    rules: [],
    usage: null,
    ...overrides,
  }
}

export function followup(overrides: Partial<Followup> = {}): Followup {
  return {
    id: 'fu-1',
    applicationId: 'app-1',
    n: 1,
    channel: 'email',
    contactId: 'contact-1',
    to: 'ada@acme.example',
    state: 'ready',
    rewriteFrom: null,
    version: 1,
    versions: [followupVersion(1)],
    warnings: [],
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  }
}

export function valueOf<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(`expected ok, got ${result.error.code}: ${result.error.reason}`)
  return result.value
}

export function errorOf<T>(result: Result<T>, code: string, reason?: string): void {
  assert.equal(result.ok, false, 'expected an error')
  if (result.ok) return
  assert.equal(result.error.code, code, result.error.reason)
  if (reason !== undefined) assert.equal(result.error.reason, reason)
}
