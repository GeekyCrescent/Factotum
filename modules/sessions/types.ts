/**
 * The shape of the capability this module consumes, DECLARED HERE AND NOWHERE ELSE IN
 * THIS MODULE.
 *
 * This file imports nothing but `@factotum/core`. That is the rule from CLAUDE.md §1 —
 * `modules/* → packages/core`, and only to core — and it is why `modules/tsconfig.json`
 * and `modules/package.json` are untouched by the whole of this work. The engine is a
 * separate workspace package; this module never names it, not in an import and not in
 * a comment, because the criterion that checks it is an absolute grep and a grep with
 * exceptions is a grep that gets argued about.
 *
 * WHAT IT COSTS, WRITTEN DOWN RATHER THAN SOFTENED. TypeScript is structural, so the
 * two declarations meet at exactly one assignment in `packages/cli/src/main.ts`. That
 * assignment catches a member renamed or removed, an argument whose type changes
 * incompatibly, and a method that disappears. It does NOT catch a field ADDED to a
 * return type on the other side: this module would drop it in silence.
 *
 * The asymmetry runs the safe way — what escapes is a feature nobody sees, never a
 * decision taken with missing data — and it only runs that way because there is
 * exactly ONE zod schema for the config fragment and it lives in `config.ts` next
 * door. With a second schema on the engine's side, a key this one did not know about
 * would be stripped before the engine ever saw it, and that is not a feature nobody
 * sees: that is the permission boundary decided on incomplete data.
 *
 * The right fix the day there is a SECOND consumer is a shared home for these types,
 * the way the predecessor project has one. Today that would mean putting one domain's
 * types into the package that holds the contract, which is what ADR-0001 exists to
 * prevent. The signal to revisit is the third consumer, not the second.
 *
 * MEMBERS ARE FUNCTION-TYPED PROPERTIES, NEVER METHOD SYNTAX. With `launch(i: X): Y`
 * the parameter is bivariant even under `strictFunctionTypes`, and the assignment in
 * `main.ts` would stop catching an argument that changes shape — half of what it is
 * for. There is a test that removes a member and changes an argument and watches the
 * typecheck fail both times.
 */

import type { Logger, Notifier, Timers } from '@factotum/core'

// --- configuration, already parsed by config.ts ----------------------------

export interface SiteConfig {
  readonly id: string
  readonly path: string
}

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

// --- what the engine is handed ---------------------------------------------

export interface EngineSetup {
  readonly stateDir: string
  readonly sites: readonly SiteConfig[]
  /** Writable from every site, locked by nothing. Declared once in the fragment. */
  readonly sharedPaths?: readonly string[]
  readonly catalog: readonly CatalogEntry[]
  readonly log: Logger
  readonly now: () => Date
  readonly timers: Timers
  /** A thunk: at step 12 the answer does not exist yet. */
  readonly hookUrl: () => string
  /**
   * Telling the owner a turn ended. `ctx.notify`, handed over whole — the engine never learns
   * the transport. REQUIRED: an optional capability that silently does nothing is a degradation
   * nobody sees. When push is off, `canReach` says so and `send` does nothing.
   */
  readonly notify: Notifier
}

// --- what the engine does --------------------------------------------------

export type SessionState = 'running' | 'finished' | 'failed' | 'cancelled'

export interface LaunchInput {
  readonly siteId: string
  readonly entryId: string
  readonly text: string
  readonly force: boolean
}

export interface FreshnessReport {
  readonly clean: boolean
  readonly behind: number
  readonly dirtyFiles: readonly string[]
  readonly remoteWarning: string | undefined
}

export type LaunchResult =
  | { readonly outcome: 'started'; readonly sessionId: string }
  | { readonly outcome: 'busy'; readonly sessionId: string }
  | { readonly outcome: 'stale'; readonly freshness: FreshnessReport }
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

export type SessionEvent = { readonly seq: number; readonly at: string } & (
  | { readonly kind: 'message'; readonly role: 'user' | 'assistant'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string; readonly input: unknown }
  | { readonly kind: 'result'; readonly name: string; readonly ok: boolean; readonly summary: string }
  | { readonly kind: 'state'; readonly state: SessionState; readonly reason: string | undefined }
)

export interface EventPage {
  readonly events: readonly SessionEvent[]
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

export type Decision = 'allow' | 'deny' | 'ask'

export interface HookDecision {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse'
    readonly permissionDecision: Decision
    readonly permissionDecisionReason: string
  }
}

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
