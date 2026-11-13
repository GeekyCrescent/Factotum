/**
 * The facade's public types (design D3 «La fachada», D13, D15; tasks C1): what `createJobs` answers
 * and what `modules/jobs` mirrors BY HAND (C2) — the module imports only `@factotum/core`, and the two
 * declarations meet at one assignment in `packages/cli/src/main.ts` (`const jobsFactory: CreateJobs =
 * createJobs`, C3).
 *
 * MEMBERS ARE FUNCTION-TYPED PROPERTIES, never method syntax: a method's parameter is bivariant, and
 * that assignment would stop catching an argument that changes shape (as `@factotum/tasks`).
 *
 * THE VIEWS ARE THE SCREEN'S (`modules/jobs/client/contract.ts`): a card's texts come with their slots
 * filled (D6 «Huecos»: shown filled, never stored filled), its company and contact resolved, its files
 * as module paths. Every batch item carries `seen` (D15 «Lo que se vio es lo que se aprueba»).
 */

import type { Logger, Timers } from '@factotum/core'
import type { PasswordResult, SendInput, SendResult } from '@factotum/mail'

import type { MailHealth, FileStat } from '../mail-health.ts'
import type { Decided, DecisionKind } from '../review/decide.ts'
import type { ImportReport } from '../seed/report.ts'
import type { AnswerOptions } from '../send/assist.ts'
import type { FetchLike, Lookup } from '../scout/net.ts'
import type {
  Address,
  AppState,
  Application,
  Channel,
  FollowupState,
  JobEvent,
  ProfileVersion,
  Result,
  Rule,
  Send,
  SendKind,
  Warning,
  WarningCode,
} from '../types.ts'

// ── Creating it ──────────────────────────────────────────────────────────────────────────────────

export interface JobsDeps {
  /** RAW: the module carries it as `z.unknown()`; the one schema is `config.ts` (D13). */
  readonly config: unknown
  /** `<stateDir>`: `jobs.db`, `artifacts/`, `backups/`, `run/`. */
  readonly stateDir: string
  readonly log: Logger
  readonly now: () => Date
  /** `ctx.timers`: the kernel owns every timer (CLAUDE.md §6). */
  readonly timers: Timers
  // The seams below are for tests and dev only — never from the configuration.
  /** fake-claude; `CLAUDE_BIN`/`claude` without it. */
  readonly claudeBin?: string | undefined
  /** The SMTP send; `@factotum/mail`'s `sendMail` without it. */
  readonly sendMail?: ((input: SendInput) => Promise<SendResult>) | undefined
  /** The real read of the app password; `@factotum/mail`'s without it. */
  readonly readPassword?: ((file: string) => Promise<PasswordResult>) | undefined
  /** The `lstat` of the password file's health check (D13 step 5). */
  readonly lstat?: ((path: string) => Promise<FileStat>) | undefined
  /** The network of the address checks and the live ad; `globalThis.fetch` and the system's DNS without them. */
  readonly fetch?: FetchLike | undefined
  readonly lookup?: Lookup | undefined
}

/** `GET /where`: this host keeps jobs, or relays to the one that does (D13). */
export type WhereView = { readonly mode: 'host' } | { readonly mode: 'relay'; readonly host: string }

/** A host in relay mode (the Mac): nothing but where jobs lives. */
export interface JobsRelay {
  readonly where: () => WhereView
  readonly stop: () => Promise<void>
}

export type CreateJobsResult =
  | { readonly ok: true; readonly jobs: Jobs }
  | { readonly ok: true; readonly relay: JobsRelay }
  | { readonly ok: false; readonly reason: string }

export type CreateJobs = (deps: JobsDeps) => Promise<CreateJobsResult>

// ── Health and overview (D13 `GET /health`, D15) ─────────────────────────────────────────────────

export type PathState = 'ok' | 'missing'

export interface Health {
  /** The app password's file (D13 step 5): `unknown` until its `lstat` is back. */
  readonly mail: MailHealth
  /** The generation queue: paused by a usage limit until then (D10); null when it runs. */
  readonly queue: { readonly pausedUntil: string | null; readonly running: number }
  /** What `start` found on disk (step 3): a missing one warns, never switches the module off. */
  readonly paths: {
    readonly vault: PathState
    readonly cvMaster: PathState
    readonly chromium: PathState
    readonly pdfinfo: PathState
    readonly pdftoppm: PathState
    readonly font: PathState
  }
  /** Since when the daily copy keeps failing (D2); null while copies work. */
  readonly backupFailing: string | null
  /** Each problem above as one line for the screen, without a path or a value. */
  readonly warnings: readonly string[]
}

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

/**
 * `GET /overview`, AS THE SCREEN READS IT (`modules/jobs/client/contract.ts` `Overview`). The test
 * application is never counted (crit. 63).
 */
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
  /** `ready` applications outside the open batch: «Start review (N)». */
  readonly reviewable: number
  /** A batch is open: the tracker continues it instead of arming another over it. */
  readonly batchOpen: boolean
  /** The current profile has no phone (R9): nothing becomes ready. */
  readonly missingPhone: boolean
  /** `health().warnings`. */
  readonly notices: readonly string[]
  /** Every `send-unknown` and `failed` row of an application that is not closed. */
  readonly sends: readonly SendNeed[]
  /** Applications by state, for the engine's own tests and the T2a list; the screen does not read it. */
  readonly byState: Readonly<Partial<Record<AppState, number>>>
}

// ── The cards (the screen's views) ───────────────────────────────────────────────────────────────

export interface CompanyRef {
  readonly id: string
  readonly name: string
}

export interface ContactView {
  readonly id: string
  readonly name: string | null
  readonly email: string | null
  /** null when the contact has no email. */
  readonly address: Address | null
}

/** A generation (`cv`, `letter`) or a reprint (D10): `pending` while queued or running, `failed` once it gave up. */
export interface JobStatus {
  readonly state: 'idle' | 'pending' | 'failed'
  readonly reason: string | null
}

/** `GET /a/:id/sends/:kind` (D9 step 4). */
export interface SendView {
  readonly kind: SendKind
  readonly state: Send['state']
  readonly at: string
  readonly reason: string | null
}

export interface FormAnswerView {
  readonly question: string
  readonly answer: string
  readonly ok: boolean
  readonly hint: string | null
}

export interface ApplicationCard {
  readonly id: string
  readonly state: AppState
  readonly channel: Channel
  readonly test: boolean
  readonly version: number
  readonly company: CompanyRef
  readonly role: string
  readonly hours: string | null
  readonly score: number | null
  readonly adUrl: string | null
  /** The URL «Switch to form» would use (T-A10); null = the switch is off. */
  readonly formUrl: string | null
  /** Email only. */
  readonly contact: ContactView | null
  readonly to: string | null
  /** Slots filled. */
  readonly letter: { readonly subject: string | null; readonly body: string } | null
  readonly form: readonly FormAnswerView[]
  readonly linkedin: string | null
  readonly cv: {
    readonly base: 'A' | 'B' | null
    /** Module paths: `a/<id>/v/<version>/preview.png`, `a/<id>/v/<version>/<Name>-CV.pdf`. */
    readonly png: string | null
    readonly pdf: string | null
    readonly tailored: string | null
  }
  readonly notes: string
  readonly warnings: readonly Warning[]
  readonly jobs: { readonly cv: JobStatus; readonly letter: JobStatus; readonly reprint: JobStatus }
  readonly sends: readonly SendView[]
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
  readonly failed: boolean
  readonly instruction: string | null
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

/** One element of the batch, resolved for the screen, with its `seen`. */
export type ReviewItem = { readonly itemId: string; readonly seen: string } & (
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
  /** The test application's own batch: the header says «TEST». */
  readonly test: boolean
  readonly items: readonly ReviewItem[]
  readonly cursor: number
  readonly results: Readonly<Record<string, ItemResult>>
  /** Items whose rewrite has not come back yet. */
  readonly rewriting: number
}

/** `GET /batch` and `POST /batch`. */
export interface BatchAnswer {
  readonly batch: BatchView | null
  readonly ready: number
}

/** `GET /a/:id`: the card and its events, oldest first. */
export interface ApplicationDetail {
  readonly application: ApplicationCard
  readonly events: readonly JobEvent[]
}

// ── Inputs and outcomes ──────────────────────────────────────────────────────────────────────────

/** `POST /batch/decide` (D15); checked by the facade, so it may come straight from a body. */
export interface DecisionInput {
  readonly itemId: string
  readonly kind: DecisionKind
  readonly reason?: string
  readonly text?: string
  readonly addressOverride?: boolean
  readonly warningCodes?: readonly WarningCode[]
  readonly seen?: string
}

/** What a decision did; an email's approve answers `send.state: 'sending'` without waiting for SMTP (D9). */
export type DecisionOutcome = Decided

export type UnknownAnswer = 'went' | 'again' | 'not-went'

/** «Retry» / «Retry print» of a card (`POST /a/:id/retry { job }`). */
export type RetryJob = 'cv' | 'letter' | 'reprint'

// ── The facade (D3), as far as cut 1a goes ──────────────────────────────────────────────────────

export interface Jobs {
  readonly where: () => WhereView
  readonly overview: () => Overview
  readonly application: (id: string) => Result<ApplicationDetail>
  readonly importSeed: (input: { readonly dryRun: boolean }) => Promise<Result<ImportReport>>
  readonly profile: () => ProfileVersion
  /**
   * D6 «Re-lint» in the same `tx`; `relinted`: how many changed; `skipped`: how many could not be
   * linted (the master CV unreadable, the vault offline) and kept their warnings — never a failed save.
   */
  readonly saveProfile: (input: unknown) => Result<ProfileVersion & { readonly relinted: number; readonly skipped: number }>
  readonly rules: () => readonly Rule[]
  /** A new rule, or an edit of `id`; re-lints as `saveProfile`. */
  readonly saveRule: (input: unknown, id?: string) => Result<Rule & { readonly relinted: number; readonly skipped: number }>
  /** Synchronous, no network: it does not wait for address checks (D9). */
  readonly startBatch: () => Result<BatchAnswer>
  readonly batch: () => Result<BatchAnswer>
  /** Never waits for SMTP (D9). */
  readonly decide: (input: unknown) => Result<DecisionOutcome>
  readonly retry: (id: string, job: RetryJob) => Result<{ readonly queued: readonly ('cv' | 'letter')[] }>
  /** The client's poll. */
  readonly send: (id: string, kind: SendKind) => Result<SendView>
  readonly markSent: (id: string, kind: SendKind) => Result<Application>
  /** `options.expect`: the row the screen saw; moved since → `conflict 'stale'`, nothing done (D15). */
  readonly resolveUnknown: (id: string, kind: SendKind, answer: UnknownAnswer, options?: AnswerOptions) => Result<SendView>
  readonly retrySend: (id: string, kind: SendKind, options?: AnswerOptions) => Result<SendView>
  /** «Close» (T-A26, T-A21): wraps `closeApplication`. */
  readonly close: (id: string, input: { readonly reason: string }) => Result<Application>
  /** Synchronous: reads the caches. */
  readonly health: () => Health
  /** The real path of a version's PDF or preview, read from its artifacts row, confined to `<stateDir>/artifacts/`. */
  readonly file: (id: string, version: number, kind: 'pdf' | 'png') => Result<string>
  readonly stop: () => Promise<void>
}
