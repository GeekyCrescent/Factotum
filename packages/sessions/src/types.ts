/**
 * The shape of the engine, declared where the engine lives.
 *
 * THIS FILE IS DECLARED TWICE, ON PURPOSE. `modules/sessions/types.ts` carries the
 * same shapes, written out by hand, because a module may only depend on
 * `@factotum/core` and this package is not core. TypeScript is structural, so the two
 * meet at a single assignment in `packages/cli`, and that assignment is the only thing
 * standing between the two copies and silent drift.
 *
 * What that assignment catches: a member renamed or removed here, an argument whose
 * type changes incompatibly, a method that disappears from the facade.
 *
 * What it does NOT catch: a field ADDED to a return type here. The module would drop
 * it in silence. The asymmetry runs in the safe direction — what escapes is a feature
 * nobody sees, never a decision taken with missing data — and it only runs that way
 * because there is exactly ONE zod schema for the config fragment, and it lives in the
 * module. Two schemas and a key this side knew about would vanish before reaching the
 * engine, which IS the permission boundary decided on incomplete data.
 *
 * MEMBERS ARE FUNCTION-TYPED PROPERTIES, NEVER METHOD SYNTAX, and that is not style.
 * With `launch(i: LaunchInput): Promise<…>` TypeScript treats the parameter as
 * BIVARIANT even under `strictFunctionTypes`, and the compiler link would stop
 * catching an argument that changes shape — half of what it exists to catch.
 */

import type { Logger, Notifier, Timers } from '@factotum/core'

// --- Configuration, as it arrives already parsed ---------------------------

export interface SiteConfig {
  readonly id: string
  /** Absolute, no `..`. Its EXISTENCE is checked at step 12, never at step 6. */
  readonly path: string
}

/**
 * How a catalog entry reaches the CLI. `kind` is a plain string and not a union on
 * purpose: an entry naming a kind this build does not know has to be DISABLED WITH A
 * REASON, not able to sink the whole fragment. Criterion 14 is the difference.
 */
export interface InvokeConfig {
  readonly kind: string
  /**
   * `?:` AND `| undefined` BOTH, and neither is redundant under
   * `exactOptionalPropertyTypes`.
   *
   * This type has to be exactly what the module's zod schema infers, because that
   * schema's output IS this value: `z.string().optional()` produces a property that
   * may be ABSENT (so `?:`) or present and explicitly undefined (so `| undefined`).
   * Writing either half alone makes the parsed config unassignable to the engine's
   * setup — which is the compiler correctly noticing that the two are not the same
   * type, and is the whole reason the link in `main.ts` is worth having.
   */
  readonly name?: string | undefined
}

export interface CatalogEntry {
  readonly id: string
  readonly label: string
  readonly invoke: InvokeConfig
}

// --- What the engine is handed ---------------------------------------------

/** Everything the engine needs. Nothing is added to it from outside. */
export interface EngineSetup {
  readonly stateDir: string
  readonly sites: readonly SiteConfig[]
  /**
   * Directories writable from every site. Declared once, locked by nothing — see the
   * comment on `DecideInput.shared`. Optional because a setup without one is the
   * normal case, not a setup missing something.
   */
  readonly sharedPaths?: readonly string[]
  readonly catalog: readonly CatalogEntry[]
  readonly log: Logger
  /** `ctx.now` and `ctx.timers`, as handed over. The kernel owns both. */
  readonly now: () => Date
  readonly timers: Timers
  /**
   * Where this daemon can be reached. A THUNK because at step 12 the answer does not
   * exist yet: `boot` composes it at step 13 and the composition root fills it in on
   * the next statement.
   */
  readonly hookUrl: () => string
  /**
   * Telling the owner a turn ended. `ctx.notify`, handed over whole — the engine never learns
   * the transport. REQUIRED: an optional capability that silently does nothing is a degradation
   * nobody sees. When push is off, `canReach` says so and `send` does nothing.
   */
  readonly notify: Notifier
}

// --- What the engine does --------------------------------------------------

export type SessionState = 'running' | 'finished' | 'failed' | 'cancelled'

export interface LaunchInput {
  readonly siteId: string
  readonly entryId: string
  readonly text: string
  /** Launch anyway over a freshness warning. Required, so neither copy of this file
   *  has to agree about `exactOptionalPropertyTypes`. */
  readonly force: boolean
}

export interface FreshnessReport {
  readonly clean: boolean
  /** 0 also when there is no remote to compare against. */
  readonly behind: number
  readonly dirtyFiles: readonly string[]
  /** Why the comparison could not be made. Never a reason to refuse to start. */
  readonly remoteWarning: string | undefined
}

/**
 * A UNION, NOT AN EXCEPTION, and that is a decision.
 *
 * `server.ts:117-119` replaces a module exception's message with a generic one before
 * it reaches the client — deliberately, because a message can carry paths. So a
 * refusal thrown from here arrives at the phone as "module failed to handle this
 * request" and the reason is lost. Refusals the owner needs to READ therefore travel
 * as values. Programming errors still throw.
 */
export type LaunchResult =
  | { readonly outcome: 'started'; readonly sessionId: string }
  /** The site already has a live session. Carries its id, for criterion 17. */
  | { readonly outcome: 'busy'; readonly sessionId: string }
  /** A git site that is dirty or behind, and `force` was not set. */
  | { readonly outcome: 'stale'; readonly freshness: FreshnessReport }
  /** Unknown site, unknown or disabled catalog entry, session not resumable. */
  | { readonly outcome: 'rejected'; readonly reason: string }

export interface SessionSummary {
  readonly id: string
  readonly siteId: string
  readonly entryId: string
  readonly state: SessionState
  readonly startedAt: string
  readonly endedAt: string | undefined
  readonly reason: string | undefined
  readonly turns: number
  /** The first prompt, cut. `undefined` for a session from before the field existed. */
  readonly prompt: string | undefined
}

export interface Page {
  readonly page: number
}

export interface SessionPage {
  readonly sessions: readonly SessionSummary[]
  readonly page: number
  readonly hasMore: boolean
}

/**
 * The four kinds. Anything the stream carries that is not one of these is dropped.
 *
 * Split from `SessionEvent` rather than written as one `Omit<…>`, because `Omit` over
 * a type whose union sits inside an intersection collapses the union and loses the
 * discrimination — the store would then accept `{kind:'tool', text:'…'}`.
 */
export type EventInput =
  | { readonly kind: 'message'; readonly role: 'user' | 'assistant'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string; readonly input: unknown }
  | { readonly kind: 'result'; readonly name: string; readonly ok: boolean; readonly summary: string }
  | { readonly kind: 'state'; readonly state: SessionState; readonly reason: string | undefined }

export type SessionEvent = { readonly seq: number; readonly at: string } & EventInput

export interface EventPage {
  readonly events: readonly SessionEvent[]
  /** What to ask for next. The cursor IS the log; a reconnect is the same request. */
  readonly nextSeq: number
  readonly state: SessionState
}

/** What answering an ask came to. Discriminated by `kind`: a boolean cannot tell four apart. */
export type AnswerResult =
  | { readonly kind: 'answered' }
  /** Answered before. Idempotent, not an error: a service worker may retry. */
  | { readonly kind: 'already' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'unknown' }

/** What an ask is about to write, cut to what the panel shows. `null` fields, never undefined: JSON. */
export interface AskPreview {
  readonly head: string
  readonly tail: string
  readonly total: number
  readonly edits: number | null
}

/**
 * One ask, as seen by someone who HOLDS ITS TOKEN — never a list. `settled` covers answered and
 * expired alike: reading cannot tell them apart and does not need to.
 */
export type InspectResult =
  | {
      readonly kind: 'pending'
      readonly sessionId: string
      readonly toolName: string
      readonly target: string
      readonly preview: AskPreview | null
      readonly deadlineAt: string
    }
  | { readonly kind: 'settled' }
  | { readonly kind: 'unknown' }

/** The CLI's own type, all three members. `decide` produces `ask` when someone can be reached (ADR-0009) — but the HOOK REPLY is only ever allow or deny: the engine holds it and answers with what the owner said. */
export type Decision = 'allow' | 'deny' | 'ask'

/** The body of the 200 that IS the decision. Shape measured in requirements §0.8. */
export interface HookDecision {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse'
    readonly permissionDecision: Decision
    readonly permissionDecisionReason: string
  }
}

/** What the screens need to draw the launch form in one request. */
export interface EngineSetupView {
  readonly sites: readonly { readonly id: string; readonly path: string; readonly isRepo: boolean }[]
  readonly catalog: readonly {
    readonly id: string
    readonly label: string
    readonly disabledReason: string | undefined
  }[]
}

export interface SessionEngine {
  readonly launch: (input: LaunchInput) => Promise<LaunchResult>
  /**
   * `force` REQUIRED, not optional — the same rule as `LaunchInput.force`, and here it is about the
   * compiler link in main.ts: `(id, text, force?) => X` IS assignable to `(id, text) => X`, so an
   * optional one would let a stale copy of this file compile. Three required parameters are not
   * assignable to two, and that is what keeps the two declarations honest (ADR-0005).
   */
  readonly reply: (id: string, text: string, force: boolean) => Promise<LaunchResult>
  readonly cancel: (id: string) => Promise<void>
  readonly list: (page: Page) => Promise<SessionPage>
  readonly read: (id: string, fromSeq: number) => Promise<EventPage>
  readonly decide: (payload: unknown) => Promise<HookDecision>
  /**
   * The owner's answer to an ask. The id is a capability — it authorises the answer — and lives
   * only in memory and in the encrypted push (spec §5). A PROPERTY OF FUNCTION TYPE, never method
   * syntax, like every member here.
   */
  readonly answer: (askId: string, decision: 'allow' | 'deny') => Promise<AnswerResult>
  /** One ask by its token, for the approval panel (spec D8). A property, like every member here. */
  readonly inspect: (askId: string) => Promise<InspectResult>
  readonly reconcile: () => Promise<void>
  readonly view: () => EngineSetupView
  readonly stop: () => Promise<void>
}

export type CreateEngine = (setup: EngineSetup) => Promise<SessionEngine>
