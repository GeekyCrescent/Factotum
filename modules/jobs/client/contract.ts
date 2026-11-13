/**
 * What the shell hands this module, and what the jobs server answers, declared HERE, by hand and
 * structurally (spec 2026-11-12-postulaciones, design D13, D15) — as `modules/tasks/client/contract.ts`
 * does. A module imports only `@factotum/core` (CLAUDE.md §1; criterion 70): nothing here comes from
 * `@factotum/jobs`, `apps/web` or another module. The shell's props meet these where `modules.ts`
 * puts `jobsClient` in its list; the server's answers meet them in `modules/jobs/server.ts`.
 *
 * THE VIEWS ARE THE SCREEN'S, not the store's: a review item arrives with its texts already passed
 * through `fillSlots` (D6 «Huecos»: shown filled, never stored filled), its company's name and its
 * contact's address resolved, and its file links as module paths for `api.url`.
 */

// ── The shell ────────────────────────────────────────────────────────────────────────────────────

export interface Api {
  readonly get: <T>(path: string) => Promise<T>
  readonly post: <T>(path: string, body?: unknown) => Promise<T>
  /** The address of one of this module's routes, for an `<img>` or a download. */
  readonly url: (path: string) => string
}

export interface NavigateOptions {
  readonly replace?: boolean
  readonly host?: string | null
}

export interface ViewProps {
  readonly api: Api
  /** The host this screen is on, from `/h/<host>/`; `undefined` for the one serving the app. */
  readonly host: string | undefined
  /** What follows `/m/jobs/`: `''`, `review`, `a/<id>`, `settings`… (D15 «Rutas del cliente»). */
  readonly rest: string
  readonly navigate: (rest: string, options?: NavigateOptions) => void
}

/**
 * A failed request, read structurally (`apps/web/src/api.ts` `readResponse`): the status and the
 * server's `{ error: { code, message } }`. The jobs server puts its `reason` in `message`
 * (`check-pending`, `address-unverified`…).
 */
export interface RequestError {
  readonly status?: number
  readonly message?: string
  /** The parsed answer: `{ error: { code, message, field? } }` (R6 reads `field` of a `400`). */
  readonly body?: unknown
}

// ── The domain, as far as the screen needs it (design D3, D6) ────────────────────────────────────

export type Channel = 'email' | 'form' | 'platform' | 'linkedin'

export type AppState =
  | 'draft'
  | 'generating'
  | 'in-review'
  | 'ready'
  | 'rewriting'
  | 'approved'
  | 'sending'
  | 'send-unknown'
  | 'sent'
  | 'replied'
  | 'closed'

export type FollowupState = 'draft' | 'ready' | 'rewriting' | 'sending' | 'send-unknown' | 'sent' | 'failed' | 'cancelled'

export type WarningCode =
  | 'placeholder'
  | 'confidential-name'
  | 'health-keyword'
  | 'health-mentions'
  | 'forbidden-stack'
  | 'unknown-number'
  | 'unsupported-claim'
  | 'external-link'
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

export interface Warning {
  readonly code: WarningCode
  readonly where: 'cv' | 'letter' | 'form' | 'linkedin' | 'subject' | 'followup' | 'ad' | 'to'
  /** «number 13 not in cv-maestro»; for `missing-profile-field`, the field (`suburb`, `timezone`…). */
  readonly detail: string
  readonly blocks: boolean
  readonly overridden: { readonly at: string } | null
}

export type AddressStatus = 'checking' | 'verified' | 'unverified'

export interface Address {
  readonly status: AddressStatus
  readonly verifiedUrl: string | null
  /** The last FINISHED check; null = never checked. */
  readonly checkedAt: string | null
  /** «Send anyway» (T-D5). */
  readonly override: { readonly at: string } | null
}

export interface ContactView {
  readonly id: string
  readonly name: string | null
  readonly email: string | null
  /** null when the contact has no email. */
  readonly address: Address | null
}

export type SendKind = 'initial' | 'followup-1' | 'followup-2'
export type SendState = 'sending' | 'sent' | 'send-unknown' | 'failed'

/** `GET /a/:id/sends/:kind` answers this (D9 paso 4). */
export interface SendView {
  readonly kind: SendKind
  readonly state: SendState
  /** The last change of state. */
  readonly at: string
  /** Of `failed`, masked. */
  readonly reason: string | null
}

/** A generation (`cv`, `letter`) or a reprint of one application (D10): what `missing-cv`, `missing-letter` and `cv-stale` show. */
export interface JobStatus {
  /** `pending`: queued or running. `failed`: it gave up (D10 «Reintentos»). `idle`: none asked. */
  readonly state: 'idle' | 'pending' | 'failed'
  readonly reason: string | null
}

export interface CompanyRef {
  readonly id: string
  readonly name: string
}

export interface FormAnswer {
  readonly question: string
  readonly answer: string
  readonly ok: boolean
  /** A note for the owner (D8 paso 2); never copied. */
  readonly hint: string | null
}

export interface ApplicationCard {
  readonly id: string
  readonly state: AppState
  readonly channel: Channel
  readonly test: boolean
  /** The current version of its artifacts. */
  readonly version: number
  readonly company: CompanyRef
  readonly role: string
  /** «part-time», «20 h/week»… the ad's `hours`. */
  readonly hours: string | null
  readonly score: number | null
  /** The ad. */
  readonly adUrl: string | null
  /** The URL «Switch to form» would use (T-A10); null = the switch is off. */
  readonly formUrl: string | null
  /** Email only: the contact whose address is used, and the copy of it in `target.to`. */
  readonly contact: ContactView | null
  readonly to: string | null
  /** Slots filled. */
  readonly letter: { readonly subject: string | null; readonly body: string } | null
  readonly form: readonly FormAnswer[]
  readonly linkedin: string | null
  readonly cv: {
    readonly base: 'A' | 'B' | null
    /** Module paths for `api.url`: `a/<id>/v/<version>/preview.png`, `a/<id>/v/<version>/<name>.pdf`. */
    readonly png: string | null
    readonly pdf: string | null
    /** «tailored: …», what the CV run says it changed. */
    readonly tailored: string | null
  }
  /** «Owner notes»; never sent. */
  readonly notes: string
  readonly warnings: readonly Warning[]
  readonly jobs: { readonly cv: JobStatus; readonly letter: JobStatus; readonly reprint: JobStatus }
  readonly sends: readonly SendView[]
  // ── Added for the assist panel (R5b; D8 paso 4, D9 «El panel de asistencia»). Optional, so an
  // older server still type-checks; absent reads as null.
  /** Where a `form` or `platform` application is submitted (`target.url`); null for email and LinkedIn. */
  readonly targetUrl?: string | null
  /** `target.instruction` of a LinkedIn application: «LinkedIn message to Tom Crawford (first)». */
  readonly instruction?: string | null
  /** The package's «Skills to tick / Do not tick» (D8 paso 4); null when the entry has none. */
  readonly skills?: { readonly tick: readonly string[]; readonly doNotTick: readonly string[] } | null
}

export interface FollowupCard {
  readonly id: string
  readonly applicationId: string
  readonly n: 1 | 2
  readonly state: FollowupState
  readonly channel: 'email' | 'linkedin'
  readonly company: CompanyRef
  readonly role: string
  readonly contact: ContactView | null
  readonly to: string | null
  /** Slots filled. */
  readonly subject: string | null
  readonly body: string
  readonly warnings: readonly Warning[]
}

export interface RewriteInfo {
  readonly fromVersion: number
  /** The rewrite failed three times (A4): the version before, no diff, and «Try again». */
  readonly failed: boolean
  readonly instruction: string | null
  /** Of a failure, short. */
  readonly reason: string | null
  /** The letter (or follow-up body) of `fromVersion`, slots filled, for the diff. */
  readonly before: string | null
}

export interface ReplyCard {
  readonly applicationId: string
  readonly eventId: string
  readonly company: CompanyRef
  readonly from: string
  readonly subject: string
  readonly summary: string
  readonly link: string | null
}

/**
 * What every element of the batch carries, whatever its kind. `itemId` is stable. `seen` is the
 * engine's fingerprint of what the card shows (the artifact's version, the warnings and their
 * `overridden`, the address's state): the screen sends it back with each decision, and the engine
 * answers `409 conflict { reason: 'stale' }` without deciding when it changed since (D15 «Lo que se
 * vio es lo que se aprueba»).
 */
interface ItemBase {
  readonly itemId: string
  readonly seen: string
}

/** One element of the batch (D15 `ReviewItemRef`), resolved for the screen. */
export type ReviewItem = ItemBase &
  (
    | { readonly kind: 'application'; readonly application: ApplicationCard }
    | { readonly kind: 'followup'; readonly followup: FollowupCard }
    | { readonly kind: 'rewritten'; readonly target: 'application'; readonly application: ApplicationCard; readonly rewrite: RewriteInfo }
    | { readonly kind: 'rewritten'; readonly target: 'followup'; readonly followup: FollowupCard; readonly rewrite: RewriteInfo }
    | { readonly kind: 'reply'; readonly reply: ReplyCard }
    | { readonly kind: 'proposal'; readonly proposalId: string }
  )

export type ItemResult = 'approved' | 'skipped' | 'instructed' | 'sent'

export interface BatchView {
  readonly id: string
  /** The test application's own batch (v6, H3): the header says «TEST». */
  readonly test: boolean
  readonly items: readonly ReviewItem[]
  readonly cursor: number
  /** By `itemId`. */
  readonly results: Readonly<Record<string, ItemResult>>
  /** Items of this batch whose rewrite has not come back yet («1 still rewriting…»). */
  readonly rewriting: number
}

/** `GET /batch` and `POST /batch` answer this. */
export interface BatchAnswer {
  /** null: no batch open. */
  readonly batch: BatchView | null
  /** `ready` applications outside the open batch: «Start next batch» (crit. 37). */
  readonly ready: number
  /** R6 (crit. 15): the profile has no `identity.phone`; the review says so on top. Absent reads as false. */
  readonly missingPhone?: boolean
}

export type SkipReason = 'not-now' | 'not-a-fit' | 'duplicate' | 'other'

/** `POST /batch/decide` (D15 `Decision`, D13). */
export interface Decision {
  readonly itemId: string
  readonly kind: 'approve' | 'skip' | 'instruct' | 'override' | 'switch-to-form' | 'switch-channel'
  readonly reason?: SkipReason
  /** The instruction, or the text of an `other` skip. */
  readonly text?: string
  /** «Send anyway» (T-D5). */
  readonly addressOverride?: boolean
  /** «I checked it»: the codes it covers. */
  readonly warningCodes?: readonly WarningCode[]
  /** The `seen` of the card the owner decided on; a different one now → `409 stale`, nothing decided. */
  readonly seen?: string
}

/** What `POST /batch/decide` answers; an email's approve does not wait for SMTP (D9). */
export interface DecideAnswer {
  readonly ok: true
  readonly state?: string
}

// ── One send, by the owner (R5b; D9, D13 `POST /a/:id/sends/:kind/…`) ────────────────────────────

/**
 * `POST /a/:id/sends/:kind/unknown { answer }`: «It went» (`went`), «Send again» (`again`), «It didn't
 * go» (`not-went`: the initial, v6 M2, T-A31). Answers the `SendView` of that row after it: `sent`,
 * `sending` (again: the client polls it as an approve) or `failed` (not-went: «Retry» from there).
 */
export type UnknownAnswer = 'went' | 'again' | 'not-went'

/**
 * The row as the card showed it — its `state` and `at` — sent with every send answer (`unknown`,
 * `retry`). The engine answers `409 stale` and does nothing when the row has moved since: another
 * device answered it, or the send finished (D15 «Lo que se vio es lo que se aprueba»).
 */
export interface SendExpect {
  readonly state: SendState
  readonly at: string
}

export interface UnknownRequest {
  readonly answer: UnknownAnswer
  readonly expect?: SendExpect
}

/** `POST /a/:id/sends/:kind/retry`. */
export interface RetryRequest {
  readonly expect?: SendExpect
}

/**
 * `POST /a/:id/sends/:kind/mark` (no body): «Mark as sent» of a `form`, `platform` or `linkedin`
 * application (`markSent`, channel `manual`). Answers the `SendView` of that row, `sent`.
 * `POST /a/:id/sends/:kind/retry` (no body, R4a) answers the same shape; the screen polls after it.
 */
export type MarkAnswer = SendView

// ── The tracker, minimal (R7; design D15 «Tracker», D13 `GET /overview`; crit. 63) ────────────────

/** A send that needs the owner: «did it go?» or failed. The tracker shows one card per send. */
export interface SendNeed {
  readonly applicationId: string
  readonly company: string
  readonly kind: SendKind
  readonly state: 'send-unknown' | 'failed'
  readonly at: string
  /** Of `failed`, masked. */
  readonly reason: string | null
}

/** `GET /overview`. */
export interface Overview {
  /** crit. 63: to review (`in-review` + `ready`), approved not sent, sent, awaiting reply (sent, no human reply), interviews, offers. */
  readonly counts: {
    readonly toReview: number
    readonly approvedNotSent: number
    readonly sent: number
    readonly awaitingReply: number
    readonly interviews: number
    readonly offers: number
  }
  /** What «Start review» would put in a new batch, before `batchSize` — `ready` and `in-review` (blocked) alike (the N of «Start review (N)»). */
  readonly reviewable: number
  /** A batch is open, decided or not. */
  readonly batchOpen: boolean
  /** Its items with no result yet (0 with none open): while > 0 the tracker continues it (`GET /batch`); at 0 it offers a new one (R8). */
  readonly batchUndecided: number
  readonly missingPhone: boolean
  /** `health()`'s warnings, as sentences (password file, IMAP, paused queue, vault, chromium…). */
  readonly notices: readonly string[]
  /** Every `send-unknown` and `failed` row of `sends` whose application is still waiting on it. */
  readonly sends: readonly SendNeed[]
}

// ── Settings: the profile, the rules, the import (R6; design D7, D8, D13) ─────────────────────────

/** design D7 `Profile`, as `packages/jobs/src/types.ts` has it; `POST /profile` takes it WHOLE (strict). */
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
    readonly cvAvailabilityLine: string
  }
  readonly situation: string
  readonly availability: string
  readonly absences: readonly { readonly from: string; readonly to: string; readonly label: string }[]
  readonly goals: readonly {
    readonly id: string
    readonly label: string
    readonly enabled: boolean
    readonly text: string
    readonly payFloor: { readonly amount: number; readonly currency: string; readonly per: 'hour' | 'year' } | null
    readonly sources: readonly string[]
  }[]
  readonly level: string
  readonly redLines: {
    readonly text: string
    readonly titleWords: readonly string[]
    readonly requirementWords: readonly string[]
    readonly unpaid: boolean
    readonly equityOnly: boolean
  }
  readonly preferences: { readonly text: string; readonly rateExpectation: string }
  readonly forbiddenStacks: readonly string[]
  readonly confidential: readonly string[]
  readonly batchSize: number
  readonly weights: Readonly<Record<string, number>>
  readonly followup: { readonly subject: string; readonly first: string; readonly second: string; readonly linkedin: string }
}

/** `GET /profile` answers the current version. */
export interface ProfileVersion {
  readonly version: number
  readonly createdAt: string
  readonly profile: Profile
}

/**
 * `POST /profile` (body: a whole `Profile`) answers the new version and how many unsent applications
 * the re-lint changed (D6). A refusal is `400 { error: { code: 'invalid', message, field } }`, with
 * `field` the dotted path of the first issue (`identity.phone`, `goals.0.payFloor.currency`).
 */
export type SavedProfile = ProfileVersion & { readonly relinted: number }

export type RuleScope = 'all' | Channel

export interface Rule {
  readonly id: string
  readonly text: string
  readonly scope: RuleScope
  readonly enabled: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

/** `GET /rules`. */
export interface RulesAnswer {
  readonly rules: readonly Rule[]
}

/** `POST /rules`: a new rule (crit. 17: text 1–300). */
export interface NewRule {
  readonly text: string
  readonly scope: RuleScope
  readonly enabled?: boolean
}

/** `POST /rules/:ruleId`: an edit; «Turn off» is `{ enabled: false }` (D7: it switches off, the row stays). */
export interface RuleEdit {
  readonly text?: string
  readonly scope?: RuleScope
  readonly enabled?: boolean
}

/** `POST /rules` and `POST /rules/:ruleId` answer the rule as saved and the re-lint's count. */
export type SavedRule = Rule & { readonly relinted: number }

/** `POST /import { dryRun }` (D8). The real one without a phone: `422`, message `missing-phone`. */
export interface ImportRequest {
  readonly dryRun: boolean
}

interface EntryRef {
  readonly file: string
  readonly n: number
}

/** `ImportReport` of `packages/jobs/src/seed/report.ts`, as far as the screen reads it. */
export interface ImportReport {
  readonly dryRun: boolean
  readonly blocked: 'missing-phone' | 'missing-profile' | null
  readonly companies: { readonly read: number; readonly created: number; readonly suggestedHealth: readonly string[] }
  readonly files: readonly {
    readonly file: string
    readonly entries: number
    readonly channels: Readonly<Record<Channel, number>>
    readonly new: number
    readonly existing: number
    readonly holdUntil: string | null
    readonly byHand: boolean
  }[]
  readonly missing: readonly (EntryRef & { readonly missing: readonly string[] })[]
  readonly unmatched: readonly (EntryRef & { readonly company: string })[]
  readonly placeholders: readonly (EntryRef & { readonly where: string; readonly token: string })[]
  readonly kitRefs: readonly (EntryRef & { readonly question: string; readonly section: number; readonly matched: string | null; readonly ambiguous: boolean })[]
  readonly verified: readonly (EntryRef & { readonly email: string; readonly evidence: string })[]
  readonly issues: readonly { readonly kind: string; readonly file: string; readonly n: number | null; readonly detail: string }[]
  readonly byHand: readonly (EntryRef & { readonly at: string | null; readonly result: string })[]
  readonly byHandPending: readonly (EntryRef & { readonly company: string })[]
  readonly queued: { readonly cv: number; readonly checks: number }
  readonly warnings: readonly string[]
}
