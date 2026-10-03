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

import type { Logger, Notifier, ReceivedFile, Timers } from '@factotum/core'

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
  /** The id of the owner's category it sits in. One that names no category counts as none. */
  readonly category?: string | undefined
  /**
   * Several sessions at once in this project (spec 2026-10-03-varias-sesiones-por-proyecto). `true` or
   * absent: on disk a project that does not allow it has no key at all.
   */
  readonly concurrent?: true | undefined
}

/**
 * A group of projects the owner named, for the drawer alone. COSMETIC, like a name or a colour: it
 * changes nothing an agent can use, so it needs no approval (ADR-0011).
 */
export interface CategoryEntry {
  readonly id: string
  readonly name: string
}

export interface SharedEntry {
  readonly path: string
  readonly addedAt?: string | undefined
}

export interface RegistryView {
  /** IN THE OWNER'S ORDER: the drawer lists them as they are here. */
  readonly projects: readonly ProjectEntry[]
  readonly shared: readonly SharedEntry[]
  readonly categories: readonly CategoryEntry[]
}

/** An entry the reader skipped, said out loud: GET /projects and the projects screen show it. */
export interface SkippedEntry {
  readonly list: 'projects' | 'shared' | 'categories'
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
  | {
      readonly kind: 'set-project'
      readonly id: string
      readonly name?: string | undefined
      readonly color?: Color | undefined
      /** `undefined` KEEPS what is there, unlike `name` and `color` (spec 2026-10-03-varias-sesiones-por-proyecto, D5). */
      readonly concurrent?: boolean | undefined
    }
  | { readonly kind: 'remove-project'; readonly id: string }
  | { readonly kind: 'add-shared'; readonly path: string }
  | { readonly kind: 'remove-shared'; readonly path: string }
  | { readonly kind: 'set-layout'; readonly layout: ProjectLayout }

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
  /** The titler's settings, parsed by the module's one schema (spec 2026-09-30, D9). */
  readonly titles: TitlesConfig
  /** The ceiling of one upload: `UPLOAD_MAX_BYTES` from `config.ts`, the one literal (spec 2026-10-01, D4). */
  readonly uploadMaxBytes?: number
}

/** How much the titler thinks. The CLI's `--effort` levels. */
export type TitlerEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * EXACTLY what the module's zod infers for `titles`: every field has a default, so none is optional.
 * The link in `main.ts` is what keeps the two in step.
 */
export interface TitlesConfig {
  readonly enabled: boolean
  readonly model: string
  readonly effort: TitlerEffort
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
  /** The titler's title (spec 2026-09-30, D1). Shown when there is no owner's title. */
  readonly autoTitle: string | undefined
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
  | {
      readonly kind: 'result'
      readonly name: string
      readonly ok: boolean
      readonly summary: string
      /** The subagent whose tool this was, when the gate wrote it (spec 2026-10-01-subagentes-visibles). */
      readonly task?: string | undefined
    }
  | { readonly kind: 'state'; readonly state: SessionState; readonly reason: string | undefined }
  | {
      readonly kind: 'subagent'
      readonly phase: 'started'
      readonly task: string
      readonly agent: string
      readonly description: string
      readonly background: boolean
    }
  | {
      readonly kind: 'subagent'
      readonly phase: 'ended'
      readonly task: string
      readonly ok: boolean
      readonly status: string
      readonly summary: string
    }
  | QuestionsEvent
  | ServiceEvent
)

// --- Questions the agent asks the owner (spec 2026-10-01-preguntas-con-opciones, D6 bis) ---
//
// DECLARED AGAIN, BY HAND: a module cannot import `packages/sessions` (CLAUDE.md §1), and the client
// takes its types from here. The engine's copy is built from its zod schema (`questions/shape.ts`); the
// assignment in `packages/cli/src/main.ts` ties the two.

export interface QuestionOption {
  readonly id: string
  readonly label: string
  readonly description?: string | undefined
}

export interface Question {
  readonly id: string
  readonly text: string
  readonly options: readonly QuestionOption[]
  readonly multiple: boolean
}

/** Exactly one of three shapes. Zero options chosen is `none`, never an empty `chosen`. */
export type Answer =
  | { readonly question: string; readonly kind: 'chosen'; readonly options: readonly string[] }
  | { readonly question: string; readonly kind: 'text'; readonly text: string }
  | { readonly question: string; readonly kind: 'none' }

export type QuestionsOutcome = 'answered' | 'expired' | 'cancelled' | 'shutdown'

export type QuestionsEvent =
  | {
      readonly kind: 'questions'
      readonly phase: 'asked'
      /** The batch's PUBLIC id. The token that answers it is never in the log. */
      readonly id: string
      readonly questions: readonly Question[]
      readonly task?: string | undefined
    }
  | {
      readonly kind: 'questions'
      readonly phase: 'settled'
      readonly id: string
      readonly outcome: QuestionsOutcome
      readonly answers?: readonly Answer[] | undefined
      /** `token`: from a device the push reached. `screen`: from a screen with no token. */
      readonly via?: AnsweredVia | undefined
      readonly task?: string | undefined
    }

export type AnsweredVia = 'token' | 'screen'

// --- Background services (spec 2026-10-02-servicios-en-segundo-plano, D12 bis) ---
//
// DECLARED AGAIN, BY HAND, for the reason above: the engine's copy is `services/shape.ts` and the seventh
// event kind in its `types.ts`; the assignment in `packages/cli/src/main.ts` ties them.

export type ServiceOutcome = 'exited' | 'failed' | 'stopped' | 'timeout' | 'cancelled' | 'shutdown'
export type StoppedBy = 'owner' | 'agent'

export type ServiceEvent =
  | {
      readonly kind: 'service'
      readonly phase: 'started'
      readonly id: string
      readonly command: string
      readonly description?: string | undefined
      readonly cwd: string
      readonly maxMinutes: number
      readonly pid: number
      readonly task?: string | undefined
    }
  | {
      readonly kind: 'service'
      readonly phase: 'ended'
      readonly id: string
      readonly outcome: ServiceOutcome
      readonly by?: StoppedBy | undefined
      readonly code?: number | undefined
      readonly signal?: string | undefined
      readonly reason?: string | undefined
    }

/** One service, running or ended, as the owner's routes answer it. */
export interface ServiceView {
  readonly id: string
  readonly command: string
  readonly description: string | undefined
  readonly cwd: string
  readonly pid: number
  readonly maxMinutes: number
  readonly startedAt: string
  readonly task: string | undefined
  readonly state: 'running' | ServiceOutcome
  readonly endedAt: string | undefined
  readonly by: StoppedBy | undefined
  readonly code: number | undefined
  readonly signal: string | undefined
  readonly reason: string | undefined
}

export interface ServiceOutput {
  readonly view: ServiceView
  readonly lines: readonly string[]
}

/** An open batch of a session, read by a screen WITHOUT its token. */
export interface OpenBatch {
  readonly id: string
  readonly siteId: string
  readonly questions: readonly Question[]
  readonly task: string | undefined
  readonly deadlineAt: string
}

/** How a batch ended, for whoever arrives late. A shutdown reads as `cancelled`. */
export type SettledHow = 'answered' | 'expired' | 'cancelled'

export type McpReply = { readonly kind: 'body'; readonly body: unknown } | { readonly kind: 'accepted' }

export type QuestionsInspect =
  | {
      readonly kind: 'pending'
      readonly sessionId: string
      readonly siteId: string
      readonly id: string
      readonly questions: readonly Question[]
      readonly task: string | undefined
      readonly deadlineAt: string
    }
  | { readonly kind: 'over'; readonly how: SettledHow }
  | { readonly kind: 'unknown' }

export type QuestionsAnswer =
  | { readonly kind: 'answered'; readonly first: boolean }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'over'; readonly how: SettledHow }
  | { readonly kind: 'unknown' }

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
  /**
   * OPTIONAL HERE, REQUIRED ON THE ENGINE'S SIDE (spec 2026-10-01, D12). A daemon from before uploads
   * sends no such field, and the screen reads it as data rather than trusting it; the test double of
   * the engine does not have it either, and must compile untouched (criterion 10).
   */
  readonly uploads?: UploadsView
  /** Optional for the same reason as `uploads` (spec 2026-10-01-referencias-y-tab, D6; criterion 17). */
  readonly files?: FilesView
}

// --- Listing a folder for `@` references (spec 2026-10-01-referencias-y-tab, D5, D6) -------------

export interface FilesView {
  readonly maxEntries: number
}

export interface FilesQuery {
  readonly siteId: string
  readonly dir: string | undefined
  readonly prefix: string
}

export interface ListingEntry {
  readonly name: string
  readonly kind: 'dir' | 'file'
}

export interface Listing {
  readonly root: { readonly kind: 'site' | 'shared'; readonly path: string }
  readonly dir: string
  readonly entries: readonly ListingEntry[]
  readonly shared: readonly { readonly path: string; readonly name: string }[]
  readonly more: number
  readonly partial: boolean
}

export type FilesResult =
  | { readonly outcome: 'ok'; readonly listing: Listing }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'missing'; readonly siteId: string }
  | { readonly outcome: 'outside' }
  | { readonly outcome: 'unreadable'; readonly reason: string }
  | { readonly outcome: 'timeout' }

// --- Uploads (spec 2026-10-01, D5, D8) ---------------------------------------

export type UploadsView = { readonly maxBytes: number } | { readonly off: string }

export type UploadResult =
  | {
      readonly outcome: 'ok'
      readonly uploadId: string
      readonly name: string
      readonly path: string
      readonly bytes: number
      readonly image: boolean
    }
  | { readonly outcome: 'invalid'; readonly reason: string }
  | { readonly outcome: 'off'; readonly reason: string }

export type UploadLookup = { readonly kind: 'ok'; readonly path: string } | { readonly kind: 'invalid' }

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
  /** Its category's id, as the registry holds it. The client treats one naming none as none. */
  readonly category: string | undefined
  /** Several sessions at once allowed here (spec 2026-10-03-varias-sesiones-por-proyecto, D9). */
  readonly concurrent: boolean
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
  /** The daemon's home, so a screen can write paths under it as `~/…`. */
  readonly home: string
  /** Whether a request can reach a device right now (criterion 10). */
  readonly canRequest: boolean
  /** The owner's categories, in order. `projects` comes in the owner's order too. */
  readonly categories: readonly CategoryEntry[]
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
  /** `undefined` leaves it as it is: a client that does not send it changes nothing. */
  readonly concurrent?: boolean | undefined
}

/**
 * The drawer's whole arrangement, set AT ONCE: the categories in order, and EVERY project once, in
 * order, with its category. Whole rather than one move at a time, so two screens moving things never
 * interleave into an order neither asked for: the second is refused as stale and reloads.
 */
export interface ProjectLayout {
  readonly categories: readonly CategoryEntry[]
  readonly order: readonly { readonly id: string; readonly category: string | undefined }[]
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
  /** No `force`: freshness is checked once, at launch — never on a later turn. */
  readonly reply: (id: string, text: string) => Promise<LaunchResult>
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
  /** The order and the categories (see `ProjectLayout`). Cosmetic: no approval. */
  readonly setLayout: (layout: ProjectLayout) => Promise<ProjectChange>
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
  // --- uploads (spec 2026-10-01, D9, D12): optional here, like `uploads` above ---
  readonly upload?: (file: ReceivedFile, rawName: string) => Promise<UploadResult>
  readonly openUpload?: (uploadId: string, name: string) => UploadLookup
  // --- references (spec 2026-10-01-referencias-y-tab, D6): optional here, like `files` above ---
  readonly files?: (query: FilesQuery) => Promise<FilesResult>
  // --- questions (spec 2026-10-01-preguntas-con-opciones, D6 bis): optional here, required in the engine ---
  readonly mcp?: (sessionId: string, message: unknown) => Promise<McpReply>
  readonly inspectQuestions?: (token: string) => Promise<QuestionsInspect>
  readonly answerQuestions?: (token: string, body: unknown) => Promise<QuestionsAnswer>
  readonly sessionQuestions?: (sessionId: string) => Promise<readonly OpenBatch[]>
  readonly answerSessionQuestions?: (sessionId: string, batchId: string, body: unknown) => Promise<QuestionsAnswer>
  // --- background services (spec 2026-10-02, D13): optional here, required in the engine ---
  readonly readService?: (sessionId: string, id: string, lines: number) => Promise<ServiceOutput | undefined>
  readonly stopService?: (sessionId: string, id: string) => Promise<ServiceView | undefined>
  readonly view: () => EngineSetupView
  readonly stop: () => Promise<void>
}

export type CreateEngine = (setup: EngineSetup) => Promise<SessionEngine>
