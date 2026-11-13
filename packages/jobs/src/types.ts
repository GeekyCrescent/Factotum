/**
 * The shapes of job applications (spec 2026-11-12-postulaciones, design D3, D6, D7).
 *
 * `modules/jobs/types.ts` declares the public ones AGAIN, by hand: a module cannot import this package
 * (CLAUDE.md §1). The two meet at one assignment in `packages/cli/src/main.ts`.
 *
 * EVERYTHING IS READONLY. A row from the store is frozen (design D2), and a transition returns a new
 * object (`state.ts`), never the one it was given.
 */

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: JobsError }

export type ErrorCode = 'invalid' | 'not-found' | 'conflict' | 'blocked' | 'limit' | 'module-error'

/** A reason NEVER carries a value the owner typed or a secret: a path, a code, a message of ours. */
export interface JobsError {
  readonly code: ErrorCode
  readonly reason: string
  readonly field?: string
  /** The error a `tx` body threw, kept whole (stack included) for the log; never shown to the owner. */
  readonly cause?: unknown
}

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })

export function fail<T = never>(code: ErrorCode, reason: string, field?: string): Result<T> {
  return { ok: false, error: field === undefined ? { code, reason } : { code, reason, field } }
}

/** v4 (B1): `linkedin` is manual like `form` — a panel and «Mark as sent». */
export const CHANNELS = ['email', 'form', 'platform', 'linkedin'] as const
export type Channel = (typeof CHANNELS)[number]
/** «Manual» channels are approved to `approved` and closed with «Mark as sent» (T-A12, T-A13). */
export const isManualChannel = (channel: Channel): boolean => channel !== 'email'

export type OpportunityKind = 'vacancy' | 'outreach' | 'historical'

/** design D14; A6: no `gradconnection` nor `prosple`. */
export const SOURCE_IDS = [
  'seek',
  'wwr',
  'remoteok',
  'remotive',
  'yc',
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'watch',
  'linkedin-alerts',
] as const
export type SourceId = (typeof SOURCE_IDS)[number]
export type Source = 'seed' | `scout:${SourceId}` | 'linkedin-alert' | 'pasted'

export type AtsKind =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workable'
  | 'bamboohr'
  | 'workday'
  | 'smartrecruiters'
  | 'breezy'
  | 'dover'
  | 'other'

export interface Company {
  readonly id: string
  readonly name: string
  readonly domain: string | null
  readonly website: string | null
  readonly careersUrl: string | null
  readonly linkedin: string | null
  readonly sector: string | null
  readonly size: { readonly value: string; readonly source: string } | null
  readonly location: string | null
  /** v4 (B7): false by default; only the curated list or the owner turns it on. */
  readonly isHealthEmployer: boolean
  /** `guessed` is a hint from `industry`, and does NOT turn the flag on. */
  readonly healthSource: 'curated' | 'guessed' | 'owner' | null
  readonly ats: { readonly kind: AtsKind; readonly ref: string } | null
  readonly contacts: readonly Contact[]
}

export type AddressStatus = 'checking' | 'verified' | 'unverified'

export interface Address {
  readonly status: AddressStatus
  /** Where it was seen (N2), or the `website` when the package gives it as seen. */
  readonly verifiedUrl: string | null
  /** The last FINISHED check (`done` or `timed-out`); null = never. */
  readonly checkedAt: string | null
  /** «Send anyway». Reused by every follow-up to THIS address; survives a re-check (v5, X2). */
  readonly override: { readonly at: string } | null
}

/** v4 (A2): the address and its state belong to the contact, not to the application. */
export interface Contact {
  readonly id: string
  readonly companyId: string
  readonly name: string | null
  readonly role: string | null
  readonly email: string | null
  readonly sourceUrl: string | null
  /** null when there is no `email`. */
  readonly address: Address | null
}

export const SCORE_KEYS = ['partTime', 'skills', 'hiring', 'visa', 'access'] as const
export type ScoreKey = (typeof SCORE_KEYS)[number]

export interface Opportunity {
  readonly id: string
  readonly companyId: string
  readonly kind: OpportunityKind
  readonly title: string
  readonly goalId: string | null
  readonly url: string | null
  readonly postedAt: string | null
  readonly closesAt: string | null
  readonly startsAt: string | null
  readonly duration: string | null
  readonly hours: string | null
  readonly salary: string | null
  /** ≤ 16 KiB of text (`MAX_REQUIREMENTS_CHARS`). */
  readonly requirements: string
  readonly score: number | null
  readonly breakdown: Readonly<Record<ScoreKey, { readonly score: 1 | 2 | 3 | 4 | 5; readonly why: string }>> | null
  readonly profileVersion: number | null
  readonly source: Source
  readonly sourceRef: string | null
  readonly remote: { readonly usOnly: boolean; readonly contractor: boolean } | null
  readonly status: 'open' | 'closed' | 'discarded'
  readonly discardReason: string | null
  readonly checkedAt: string | null
}

export const APP_STATES = [
  'draft',
  'generating',
  'in-review',
  'ready',
  'rewriting',
  'approved',
  'sending',
  'send-unknown',
  'sent',
  'replied',
  'closed',
] as const
export type AppState = (typeof APP_STATES)[number]
export type Outcome = 'interview' | 'rejected' | 'offer' | 'no-response' | 'dropped'

export const SEND_KINDS = ['initial', 'followup-1', 'followup-2'] as const
export type SendKind = (typeof SEND_KINDS)[number]
export type SendState = 'sending' | 'sent' | 'send-unknown' | 'failed'

export interface SendAttempt {
  readonly messageId: string
  readonly at: string
  readonly reason: string | null
}

/** One row of `sends`; the key is `(application_id, kind)` (v5, X6). */
export interface Send {
  readonly kind: SendKind
  /** The `followups` row it came from; null for `initial`. */
  readonly followupId: string | null
  readonly channel: 'smtp' | 'manual'
  /** `<uuidv7@jobs.factotum.local>`; null when manual. */
  readonly messageId: string | null
  readonly state: SendState
  /** The last change of state. */
  readonly at: string
  readonly response: string | null
  /** Of `failed`, masked. */
  readonly reason: string | null
  readonly addressOverride: boolean
  /** The profile version that filled the slots when sending (D6). */
  readonly profileVersion: number | null
  /** Earlier `failed` attempts of THIS row, so a late reply still matches (D12 rule 1). */
  readonly attempts: readonly SendAttempt[]
}

export type WarningCode =
  | 'placeholder'
  | 'confidential-name'
  | 'health-keyword'
  | 'health-mentions'
  | 'forbidden-stack'
  | 'unknown-number'
  | 'unsupported-claim'
  | 'too-long'
  | 'cv-overflow'
  | 'missing-phone'
  | 'missing-profile-field'
  | 'missing-portfolio'
  | 'missing-cv'
  | 'cv-stale'
  | 'ad-closed'
  | 'senior-title'
  | 'requirement-gap'
  | 'missing-letter'
  /** 13-nov (G9): a link or an address in a sent text that is neither the profile's nor the company's. */
  | 'external-link'

export interface Warning {
  readonly code: WarningCode
  readonly where: 'cv' | 'letter' | 'form' | 'linkedin' | 'subject' | 'followup' | 'ad' | 'to'
  /** «number 13 not in cv-maestro» — never the whole text. */
  readonly detail: string
  readonly blocks: boolean
  readonly overridden: { readonly at: string } | null
}

export interface Target {
  /** The contact whose address is used (email); its state lives in `Contact.address`. */
  readonly contactId: string | null
  /** A copy of that contact's `email`. */
  readonly to: string | null
  readonly url: string | null
  readonly contactName: string | null
  /** v4 (B1): the text of the main destination of `Send via`. */
  readonly instruction: string | null
}

export interface Application {
  readonly id: string
  readonly opportunityId: string
  readonly companyId: string
  /** Changes only by «Switch to form» (T-A10). */
  readonly channel: Channel
  readonly target: Target
  readonly cvBase: 'A' | 'B' | null
  readonly state: AppState
  readonly outcome: Outcome | null
  /** Where a rewrite that fails three times goes back to (T-A9). */
  readonly rewriteFrom: 'in-review' | 'ready' | null
  /** `YYYY-MM-DD`. */
  readonly holdUntil: string | null
  /** The current version of `artifacts`. */
  readonly version: number
  /** In order: initial, followup-1, followup-2. */
  readonly sends: readonly Send[]
  /** «Owner notes» of the package; never sent. */
  readonly notes: string
  /** v6 (H3): the test application. */
  readonly test: boolean
  readonly warnings: readonly Warning[]
  readonly createdAt: string
  readonly updatedAt: string
}

export const FOLLOWUP_STATES = ['draft', 'ready', 'rewriting', 'sending', 'send-unknown', 'sent', 'failed', 'cancelled'] as const
export type FollowupState = (typeof FOLLOWUP_STATES)[number]

export interface RunUsage {
  readonly inputTokens: number
  readonly cacheCreationTokens: number
  readonly cacheReadTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly ms: number
  readonly model: string | undefined
}

export interface FollowupVersion {
  readonly version: number
  readonly subject: string | null
  /** With slots (`{signature}`), never filled. */
  readonly body: string
  readonly origin: 'template' | 'rewritten'
  readonly instruction: string | null
  readonly profileVersion: number
  readonly rules: readonly string[]
  readonly usage: RunUsage | null
}

/** A follow-up is its OWN entity (v4, A3). The application stays `sent`/`replied`. */
export interface Followup {
  readonly id: string
  readonly applicationId: string
  readonly n: 1 | 2
  readonly channel: 'email' | 'linkedin'
  readonly contactId: string | null
  readonly to: string | null
  readonly state: FollowupState
  readonly rewriteFrom: 'draft' | 'ready' | null
  readonly version: number
  readonly versions: readonly FollowupVersion[]
  /** Lint profile «follow-up» (D6): never `missing-cv` nor `cv-stale`. */
  readonly warnings: readonly Warning[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface CvDoc {
  readonly headline: string
  readonly summary: string
  readonly experience: readonly {
    readonly org: string
    readonly title: string
    readonly dates: string
    readonly place: string | null
    readonly line: string | null
    readonly bullets: readonly { readonly text: string; readonly source: string }[]
  }[]
  readonly projects: readonly {
    readonly name: string
    readonly role: string
    readonly status: string
    readonly text: string
    readonly source: string
  }[]
  readonly education: readonly { readonly text: string }[]
  readonly certifications: readonly string[]
  readonly skills: readonly { readonly label: string; readonly items: readonly string[] }[]
  readonly gaps: readonly { readonly requirement: string; readonly why: string }[]
}

/** One version of an APPLICATION's artifacts (follow-ups carry their own). Texts carry slots, never data. */
export interface Artifacts {
  readonly version: number
  readonly cv: CvDoc | null
  readonly pdf: string | null
  readonly png: string | null
  readonly contactHash: string | null
  readonly letter: { readonly subject: string | null; readonly body: string } | null
  readonly form: readonly { readonly question: string; readonly answer: string; readonly ok: boolean; readonly hint: string | null }[]
  readonly skills: { readonly tick: readonly string[]; readonly doNotTick: readonly string[] } | null
  readonly linkedin: string | null
  readonly profileVersion: number
  readonly rules: readonly string[]
  readonly usage: RunUsage | null
  readonly origin: 'seed' | 'generated' | 'rewritten' | 'reprinted'
}

/** The class of a generation request (A5, «La guarda»). */
export type GenKind = 'letter' | 'cv' | 'followup'

export const EVENT_KINDS = [
  'imported',
  'prepared',
  'instruction',
  'rewritten',
  'rewrite-failed',
  'retried',
  'approved',
  'skipped',
  'sent',
  'send-failed',
  'send-unknown',
  'resolved-by-reply',
  'reply',
  'followup-proposed',
  'followup-cancelled',
  'interview',
  'rejection',
  'offer',
  'closed',
  'note',
  'address-checked',
  'address-override',
  'channel-changed',
  'ad-checked',
  'override',
  'rule-saved',
  'profile-saved',
  'proposal-applied',
  'relinted',
  'reprint-failed',
  'reopened-by-reply',
  'unapproved',
  'test-created',
  'contact-edited',
  'reply-applied',
  'deferred-replies-failed',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/** Append-only. A follow-up's event carries `followupId` in `data`. */
export interface JobEvent {
  /** UUIDv7. */
  readonly id: string
  /** When it happened (the date of the mail, the owner's). */
  readonly at: string
  /** When it was written. */
  readonly recordedAt: string
  readonly applicationId: string | null
  readonly companyId: string | null
  readonly kind: EventKind
  readonly data: Readonly<Record<string, unknown>>
}

export type RuleScope = 'all' | Channel

export interface Rule {
  readonly id: string
  readonly text: string
  readonly scope: RuleScope
  readonly enabled: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export interface Goal {
  readonly id: string
  readonly label: string
  readonly enabled: boolean
  readonly text: string
  readonly payFloor: { readonly amount: number; readonly currency: string; readonly per: 'hour' | 'year' } | null
  readonly sources: readonly SourceId[]
}

/** design D7. Free text goes to the prompts as is; structured fields only where code decides. */
export interface Profile {
  readonly identity: {
    readonly name: string
    readonly email: string
    readonly phone: string
    readonly linkedin: string
    readonly city: string
    readonly suburb: string
    readonly timezone: string
    readonly portfolioUrl: string
    /** v4 (B9): ONE line (≤ 120, no breaks) the CV prints under the contact; it enters `contactHash`. */
    readonly cvAvailabilityLine: string
  }
  readonly situation: string
  readonly availability: string
  readonly absences: readonly { readonly from: string; readonly to: string; readonly label: string }[]
  readonly goals: readonly Goal[]
  readonly level: string
  readonly redLines: {
    readonly text: string
    readonly titleWords: readonly string[]
    readonly requirementWords: readonly string[]
    readonly unpaid: boolean
    readonly equityOnly: boolean
  }
  readonly preferences: {
    readonly text: string
    /** The `{rate}` slot; empty = the neutral sentence (`RATE_NEUTRAL`). */
    readonly rateExpectation: string
  }
  readonly forbiddenStacks: readonly string[]
  readonly confidential: readonly string[]
  readonly batchSize: number
  readonly weights: Readonly<Record<ScoreKey, number>>
  readonly followup: {
    readonly subject: string
    readonly first: string
    readonly second: string
    readonly linkedin: string
  }
}

export interface ProfileVersion {
  readonly version: number
  readonly createdAt: string
  readonly profile: Profile
}
