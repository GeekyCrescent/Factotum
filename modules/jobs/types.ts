/**
 * The shape of the capability this module consumes, DECLARED HERE AND NOWHERE ELSE IN THIS MODULE
 * (spec 2026-11-12-postulaciones, design D1, D3, D13) — the arrangement of `modules/tasks/types.ts`,
 * whose header explains it.
 *
 * Imports nothing but `@factotum/core` and this module's own client contract (CLAUDE.md §1;
 * criterion 70). The engine's `createJobs` (`packages/jobs/src/jobs.ts`) and this `CreateJobs` meet
 * at ONE assignment in `packages/cli/src/main.ts`, which catches a member renamed or removed, or an
 * argument that changes shape — and NOT a field added on the other side.
 *
 * ONLY WHAT THE ROUTES OF CUT 1a CALL (tasks C2). A view the module only hands over is `unknown`
 * here: its shape is the engine's, and the screen that reads it declares it in `client/contract.ts`.
 * The answers the client already reads (`BatchAnswer`, `SendView`) are typed against that contract,
 * so the server and the screen cannot drift apart without `tsc` saying so.
 *
 * MEMBERS ARE FUNCTION-TYPED PROPERTIES, never method syntax: a method's parameter is bivariant, and
 * the assignment in `main.ts` would stop catching an argument that changes shape.
 */

import type { Logger, Notifier, Timers } from '@factotum/core'
import type { BatchAnswer, SendKind, SendState } from './client/contract.ts'

/** A COPY of the engine's codes (`packages/jobs/src/types.ts`, `ErrorCode`). */
export type JobsErrorCode = 'invalid' | 'not-found' | 'conflict' | 'blocked' | 'limit' | 'module-error'

/** A reason never carries a value the owner typed, nor a secret (the engine's rule). */
export interface JobsError {
  readonly code: JobsErrorCode
  readonly reason: string
  readonly field?: string
  /** For the log only; never sent to the screen. */
  readonly cause?: unknown
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: JobsError }

/** A COPY of the engine's `SEND_KINDS`, for the `:kind` of a path. */
export const SEND_KINDS: readonly SendKind[] = ['initial', 'followup-1', 'followup-2']

/** «Retry» and «Retry print» (`POST /a/:id/retry { job }`; the client's, not in D13). */
export const RETRY_JOBS = ['cv', 'letter', 'reprint'] as const
export type RetryJob = (typeof RETRY_JOBS)[number]

/** «It went / Send again / It didn't go» (D9; v6 M2, v5 X9). */
export const UNKNOWN_ANSWERS = ['went', 'again', 'not-went'] as const
export type UnknownAnswer = (typeof UNKNOWN_ANSWERS)[number]

/** One row of `sends`, as far as the poll reads it; the engine's row has more, and none of it leaves. */
export interface Send {
  readonly kind: SendKind
  readonly state: SendState
  readonly at: string
  /** Of `failed`, masked. */
  readonly reason: string | null
}

/** What `decide` answers (the engine's `Decided`), as far as `POST /batch/decide` reads it. */
export interface DecisionOutcome {
  /** An approve's send: `sending` (email, D9 step 4) or `approved` (a manual channel). */
  readonly send?: { readonly state: string }
}

export interface ProfileVersion {
  readonly version: number
  readonly createdAt: string
  readonly profile: unknown
}

export interface Rule {
  readonly id: string
  readonly text: string
  readonly scope: string
  readonly enabled: boolean
}

export interface Jobs {
  /** `GET /overview`: counters and notices (D15); handed over as it is. */
  readonly overview: () => unknown
  /** `GET /a/:id`: the application with its artifacts and events. */
  readonly application: (id: string) => Result<unknown>
  /** `POST /batch`: closes the open batch and arms a new one; never waits for the network (D9). */
  readonly startBatch: () => Result<BatchAnswer>
  /** `GET /batch`: the open batch, resolved for the screen, or `batch: null`. */
  readonly batch: () => Result<BatchAnswer>
  /** `POST /batch/decide`: the body as it came; the engine shapes it (`Decision`, D15). Never waits for SMTP. */
  readonly decide: (input: unknown) => Result<DecisionOutcome>
  /** `GET /a/:id/sends/:kind`: the client's poll. */
  readonly send: (id: string, kind: SendKind) => Result<Send>
  readonly markSent: (id: string, kind: SendKind) => Result<unknown>
  readonly resolveUnknown: (id: string, kind: SendKind, answer: UnknownAnswer) => Result<Send>
  /** From `failed`. */
  readonly retrySend: (id: string, kind: SendKind) => Result<Send>
  /** «Retry» of a `missing-cv`/`missing-letter`, «Retry print» of a `cv-stale` (client contract). */
  readonly retry: (id: string, job: RetryJob) => Result<unknown>
  /** «Close» (T-A26, T-A21). In cut 1a with no route: T1 gives it one (tasks C1). */
  readonly close: (id: string, input: { readonly reason: string }) => Result<unknown>
  readonly profile: () => ProfileVersion
  /** The body as it came; answers the new version and how many items it re-linted (D6). */
  readonly saveProfile: (input: unknown) => Result<ProfileVersion & { readonly relinted: number }>
  readonly rules: () => readonly Rule[]
  /** The body as it came; with `id`, that rule (`POST /rules/:ruleId`), else a new one. */
  readonly saveRule: (input: unknown, id?: string) => Result<Rule & { readonly relinted: number }>
  /** `POST /import { dryRun }` (D8): the report. */
  readonly importSeed: (input: { readonly dryRun: boolean }) => Promise<Result<unknown>>
  /** Synchronous: reads caches only (D13 `start` step 5). */
  readonly health: () => unknown
  /** The absolute path of an artifact's file, read from its row — never built from the request. */
  readonly file: (id: string, version: number, kind: 'pdf' | 'png') => Result<string>
  readonly stop: () => Promise<void>
}

/** What `start` hands to the factory. The config is RAW: the one schema lives in the package. */
export interface JobsSetup {
  readonly config: unknown
  readonly stateDir: string
  readonly log: Logger
  readonly now: () => Date
  readonly timers: Timers
  readonly notify: Notifier
}

/**
 * A host in `relay` mode (D13; the Mac, block Y): jobs lives on another host. Cut 1a only stops it —
 * the module treats it as «off, with a reason» until block Y gives it `GET /where`.
 */
export interface JobsRelay {
  readonly stop: () => Promise<void>
}

export type CreateJobsResult =
  | { readonly ok: true; readonly jobs: Jobs }
  | { readonly ok: true; readonly relay: JobsRelay }
  | { readonly ok: false; readonly reason: string }

/** The engine's `start` (D13): parse, open the base, check, arm the tick — and nothing that waits. */
export type CreateJobs = (setup: JobsSetup) => Promise<CreateJobsResult>
