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

// --- The projects registry (spec 2026-09-29, D1) ----------------------------
//
// A CAPABILITY THAT RUNS THE OTHER WAY. Everything else in this file is what the engine offers
// the module; the registry is what the MODULE offers the engine, because the one schema of a
// project lives in the module (`config.ts`) and the engine only checks the disk (ADR-0005,
// ADR-0011). So the engine sees a READ-ONLY VIEW and hands back EDITS AS DATA, never a whole
// registry: the type crosses one way on each side, and the link in `main.ts` compiles with
// properties, not methods.

/** One of the six project tones, `--p1`…`--p6` in tokens.css. */
export type Color = 1 | 2 | 3 | 4 | 5 | 6

/** `?:` AND `| undefined`, like `InvokeConfig.name`: this is what the module's zod infers. */
export interface ProjectEntry {
  readonly id: string
  readonly path: string
  readonly name?: string | undefined
  readonly color?: Color | undefined
  readonly addedAt?: string | undefined
}

export interface SharedEntry {
  readonly path: string
  readonly addedAt?: string | undefined
}

export interface RegistryView {
  readonly projects: readonly ProjectEntry[]
  readonly shared: readonly SharedEntry[]
}

/** An entry the reader skipped, said out loud: GET /projects and the projects screen show it. */
export interface SkippedEntry {
  readonly list: 'projects' | 'shared'
  readonly index: number
  readonly reason: string
}

export type RegistryEdit =
  | {
      readonly kind: 'add-project'
      readonly id: string
      readonly path: string
      readonly name?: string | undefined
      readonly color?: Color | undefined
    }
  | { readonly kind: 'set-project'; readonly id: string; readonly name?: string | undefined; readonly color?: Color | undefined }
  | { readonly kind: 'remove-project'; readonly id: string }
  | { readonly kind: 'add-shared'; readonly path: string }
  | { readonly kind: 'remove-shared'; readonly path: string }

export type RegistryLoad =
  | {
      readonly kind: 'ok'
      readonly registry: RegistryView
      readonly warnings: readonly string[]
      readonly skipped: readonly SkippedEntry[]
    }
  | { readonly kind: 'broken'; readonly reason: string }

export type RegistryUpdate =
  | { readonly kind: 'ok'; readonly registry: RegistryView }
  | { readonly kind: 'refused' | 'failed' | 'broken'; readonly reason: string }

export interface RegistryStore {
  /** Where it lives. Said in `registryError` and in the recipe for adding one without a phone. */
  readonly file: string
  /** At start. Seeds ONLY on ENOENT; any other read error, or an invalid envelope, is `broken`. */
  readonly load: () => Promise<RegistryLoad>
  /**
   * IN A QUEUE. `decide` runs INSIDE it with the current view, so a disk check made while
   * approving sees the approval before it (criterion 15). The store applies the edit to a copy,
   * writes it, and replaces its memory ONLY once the write finished; a failed write is `failed`
   * and leaves the memory as it was, and the next write still works (criterion 4).
   */
  readonly update: (
    decide: (current: RegistryView) => Promise<RegistryEdit | { readonly refused: string }>,
  ) => Promise<RegistryUpdate>
  /** The module's id rule, so the engine does not copy it (criteria 11, 13). */
  readonly deriveId: (basename: string) => string | undefined
  readonly isValidId: (id: string) => boolean
}

// --- what the engine is handed ---------------------------------------------

export interface EngineSetup {
  readonly stateDir: string
  /** The projects and shared folders; the config's `sites` and `sharedPaths` only seed it (D1). */
  readonly registry: RegistryStore
  readonly home: string
  readonly factotumRoot: string
  readonly installRoot: string | undefined
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
  /** The owner's title. `undefined` until renamed: the client falls back to the prompt (D5). */
  readonly title: string | undefined
  readonly archived: boolean
}

export interface Page {
  readonly page: number
  readonly site: string | undefined
  readonly archived: boolean
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

/** A conversation of a project whose folder is not there is not read (criterion 25). */
export interface SiteMissing {
  readonly kind: 'site-missing'
  readonly siteId: string
}

/** An id that is not a session id (criterion 32). */
export interface InvalidId {
  readonly kind: 'invalid'
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
  readonly sites: readonly {
    readonly id: string
    readonly path: string
    readonly isRepo: boolean
    readonly name: string | undefined
    readonly color: Color | undefined
    readonly status: 'ok' | 'missing'
  }[]
  readonly catalog: readonly {
    readonly id: string
    readonly label: string
    readonly disabledReason: string | undefined
  }[]
}

// --- Projects, as the screens see them (spec 2026-09-29, D4, D8) -------------

export type ProjectStatus = 'ok' | 'missing'

export interface ProjectView {
  readonly id: string
  readonly path: string
  readonly name: string | undefined
  readonly color: Color | undefined
  readonly status: ProjectStatus
  /** Why it is `missing`. Shown on the screen only, never in a notice: it can hold a path. */
  readonly reason: string | undefined
  readonly isRepo: boolean
  /** The newest few that are not archived, and every running one. */
  readonly sessions: readonly SessionSummary[]
  /** Not archived. */
  readonly total: number
  readonly archived: number
}

export interface SharedView {
  readonly path: string
  readonly status: ProjectStatus
  readonly reason: string | undefined
}

/** Conversations whose project is no longer registered: in prod, the seven of `demo`. */
export interface RemovedView {
  readonly siteId: string
  readonly count: number
}

export interface ProjectsPage {
  readonly projects: readonly ProjectView[]
  readonly shared: readonly SharedView[]
  /** Empty while the registry is broken (criterion 6). */
  readonly removed: readonly RemovedView[]
  readonly registryError: string | undefined
  readonly skipped: readonly SkippedEntry[]
  /** Where `projects.json` is, for the recipe without a phone. */
  readonly file: string
  /** Whether a request can reach a device right now (criterion 10). */
  readonly canRequest: boolean
}

export interface ProjectRef {
  readonly id: string
  readonly name: string | undefined
  readonly color: Color | undefined
}

export type SummaryResult =
  | { readonly kind: 'ok'; readonly summary: SessionSummary; readonly project: ProjectRef | undefined }
  | { readonly kind: 'unknown' }
  | SiteMissing
  | InvalidId

/** What renaming or archiving one came to. */
export type SessionEdit =
  | { readonly outcome: 'ok'; readonly summary: SessionSummary }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'running' }
  | { readonly outcome: 'invalid'; readonly reason: string }

/** One per id asked for, in the order asked (criterion 34). */
export interface RemoveResult {
  readonly id: string
  readonly outcome: 'removed' | 'unknown' | 'running' | 'invalid'
}

/** One per conversation. No snippet: it matched by its title or its project. */
export interface SearchHit {
  readonly summary: SessionSummary
  readonly snippet: string | undefined
}

export interface ProjectRequest {
  readonly path: string
  /** Validated by the module's rule. Absent: derived from the RESOLVED folder's name. */
  readonly id: string | undefined
  readonly name: string | undefined
  readonly color: Color | undefined
}

export interface ProjectPatch {
  readonly name: string | undefined
  readonly color: Color | undefined
}

/** Why a request is a 409 rather than a 400: the screen says each differently. */
export type RequestConflict = 'broken' | 'starting' | 'too-many' | 'no-device' | 'live-sessions' | 'already-waiting'

export type RequestResult =
  | { readonly outcome: 'requested'; readonly requestId: string; readonly expiresAt: string }
  | { readonly outcome: 'invalid'; readonly reason: string }
  | { readonly outcome: 'conflict'; readonly conflict: RequestConflict; readonly reason: string }

export interface GrantOutcome {
  readonly outcome: 'approved' | 'denied' | 'rejected'
  readonly reason: string | undefined
}

export type AnswerGrantResult =
  | (GrantOutcome & { readonly first: boolean })
  | { readonly outcome: 'unknown' | 'expired' }

export type GrantRequestView =
  | {
      readonly kind: 'project'
      readonly path: string
      readonly id: string
      readonly name: string | undefined
      readonly color: Color | undefined
    }
  | { readonly kind: 'shared'; readonly path: string }

/** One request BY ITS TOKEN, for the approval panel. Never a list. */
export type GrantInspect =
  | { readonly kind: 'pending'; readonly request: GrantRequestView; readonly expiresAt: string }
  | { readonly kind: 'settled' }
  | { readonly kind: 'unknown' }

export type GrantStatus =
  | { readonly status: 'pending' | 'approved' | 'denied' | 'expired' | 'rejected'; readonly reason: string | undefined }
  | { readonly status: 'unknown' }

/** Changing, removing, or deleting the history of a project; removing a shared folder. */
export type ProjectChange =
  | { readonly outcome: 'ok'; readonly removedSessions: number }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'conflict'; readonly reason: string }
  | { readonly outcome: 'invalid'; readonly reason: string }


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
  readonly read: (id: string, fromSeq: number) => Promise<EventPage | SiteMissing | InvalidId>
  readonly decide: (payload: unknown) => Promise<HookDecision>
  readonly summary: (id: string) => Promise<SummaryResult>
  readonly rename: (id: string, title: string) => Promise<SessionEdit>
  readonly archive: (id: string, archived: boolean) => Promise<SessionEdit>
  readonly remove: (ids: readonly string[]) => Promise<readonly RemoveResult[]>
  readonly search: (query: string) => Promise<readonly SearchHit[]>
  readonly projects: () => Promise<ProjectsPage>
  readonly requestProject: (request: ProjectRequest) => Promise<RequestResult>
  readonly requestShared: (path: string) => Promise<RequestResult>
  readonly requestStatus: (requestId: string) => Promise<GrantStatus>
  readonly inspectGrant: (token: string) => Promise<GrantInspect>
  readonly answerGrant: (token: string, decision: 'allow' | 'deny') => Promise<AnswerGrantResult>
  readonly updateProject: (id: string, patch: ProjectPatch) => Promise<ProjectChange>
  readonly removeProject: (id: string) => Promise<ProjectChange>
  readonly removeHistory: (siteId: string) => Promise<ProjectChange>
  readonly removeShared: (path: string) => Promise<ProjectChange>
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
