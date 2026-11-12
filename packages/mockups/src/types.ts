/**
 * The shapes of the mockups (spec 2026-11-12-maquetas, design D2).
 *
 * `modules/mockups/types.ts` declares these AGAIN, by hand: a module cannot import this package
 * (CLAUDE.md §1). The two meet at one assignment in `packages/cli/src/main.ts`, as `tasks` does.
 *
 * MEMBERS ARE FUNCTION-TYPED PROPERTIES, never method syntax: a method's parameter is bivariant, and
 * the assignment in `main.ts` would stop catching an argument that changes shape.
 */

import type { Logger, Notifier, Timers } from '@factotum/core'

export const STAGE_IDS = ['brief', 'concepts', 'plan', 'build', 'deliver'] as const
export type StageId = (typeof STAGE_IDS)[number]
export type RunKind = StageId | 'change' | 'redeploy'
export type StepStatus = 'locked' | 'ready' | 'running' | 'stalled' | 'waiting' | 'done'

export interface StageOption {
  readonly id: string
  readonly title: string
  readonly blurb: string
  readonly url?: string
}

/** What the owner answered at a gate. The comment of a redo is the owner's, and stays in the state. */
export interface Decision {
  readonly at: string
  readonly action: 'approve' | 'choose' | 'redo'
  /** The version the decision was about. */
  readonly version: number
  readonly optionId?: string
  readonly comment?: string
}

export interface Run {
  readonly id: string
  readonly kind: RunKind
  readonly siteId: string
  readonly sessionId?: string
  readonly startedAt: string
  /** A redo: the owner's comment, and the version it replaces (copied to `_versions/` first). */
  readonly redo?: { readonly comment: string; readonly fromVersion: number }
}

export interface Step {
  readonly status: StepStatus
  /** 0 until the first accepted submission. */
  readonly version: number
  /** Present while `running` or `stalled`. */
  readonly run?: Run
  readonly options?: readonly StageOption[]
  readonly chosen?: string
  /** A redo whose launch failed: the comment goes back in the box (criterion 15). */
  readonly pendingComment?: string
  /** The session's own line about what it did, shown on the screen and NEVER in a push (D3). */
  readonly summary?: string
  readonly history: readonly Decision[]
}

export interface Change extends Step {
  readonly id: string
  readonly text: string
  readonly previewUrl?: string
  readonly phase: 'change' | 'approved' | 'redeploy'
}

export interface InputRef {
  readonly name: string
  /** `note` for a written or dictated note; otherwise the extension, lower case, or `file`. */
  readonly kind: string
  readonly bytes: number
  /** In `inputs/private/`: real client data (criterion 10). */
  readonly private: boolean
  readonly at: string
}

export interface Mockup {
  /** UUIDv7. */
  readonly id: string
  readonly name: string
  readonly client: string
  /** The project folder's name under `projectsDir`, which is also the slug of its hub. */
  readonly project: string
  /** Real, absolute: `<project>/mockup` or `mockup-<n>`. */
  readonly vaultDir: string
  /** Real, absolute. */
  readonly workDir: string
  /** `null` until found among the sessions' projects, or approved there (D7). */
  readonly buildSiteId: string | null
  /** Why `sessions` refused the work-dir as a project (a `400`): the vault stages go on (crit. 7). */
  readonly buildRefused?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly stages: Readonly<Record<StageId, Step>>
  /** At most one without `done`. */
  readonly changes: readonly Change[]
  readonly inputs: readonly InputRef[]
  readonly urls: { readonly preview?: string; readonly prod?: string }
  readonly status: 'open' | 'delivered' | 'changing' | 'archived'
}

export interface MockupsFile {
  readonly version: 1
  readonly mockups: readonly Mockup[]
}

export type MockupError =
  | { readonly code: 'invalid'; readonly field: string; readonly reason: string }
  | { readonly code: 'not-found'; readonly reason: string }
  | { readonly code: 'conflict'; readonly reason: string }
  | { readonly code: 'too-large'; readonly reason: string }
  /** The write failed: memory and disk are as they were. */
  | { readonly code: 'module-error'; readonly reason: string }
  /** A stage of a later cut (tasks.md): answered, never thrown. */
  | { readonly code: 'not-yet'; readonly reason: string }

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: MockupError }

/** A project of the vault (D7): a folder with `<folder>/<folder>.md`. */
export interface ProjectEntry {
  readonly slug: string
  readonly title: string
  /** Expanded and real; `null`: the hub has no `work-dir`, and it cannot be chosen. */
  readonly workDir: string | null
}

/** What the screen needs to tell who writes where (D7, criterion 2b). Paths are the config's, expanded. */
export interface MockupsSetup {
  readonly docsSiteId: string
  readonly projectsDir: string
  readonly workRoot: string
  readonly crossWritesAllowed: boolean
}

/** What `POST /mockups/:id/runs` (and a redo) answers: what the screen needs to launch (D5). */
export interface RunTicket {
  readonly runId: string
  readonly siteId: string
  readonly text: string
  readonly title: string
  readonly model?: string
}

export interface DocFile {
  readonly name: string
  readonly frontmatter: Readonly<Record<string, string>>
  readonly markdown: string
  readonly mtime: string
}

export interface Created {
  readonly mockup: Mockup
  /** «map not updated: …» (criterion 6b). */
  readonly mapWarning?: string
}

export interface Decided {
  readonly mockup: Mockup
  /** A redo also starts its run (D6). */
  readonly run?: RunTicket
}

/** What `create_task`-style tools look like in `tools/list` — the sessions MCP's `McpTool`. */
export interface AgentTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

export interface AgentToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly isError?: true
}

export interface AgentCall {
  readonly sessionId: string
  readonly siteId: string
  readonly toolUseId: string | undefined
  readonly name: string
  readonly raw: unknown
}

export interface AgentToolImpl {
  readonly tools: () => readonly AgentTool[]
  readonly call: (input: AgentCall) => Promise<AgentToolResult>
}

/** The link the composition root hands to `sessions` and to `mockups` (design D1). */
export interface MockupsLink {
  readonly family: AgentToolImpl
  readonly fill: (impl: AgentToolImpl) => void
  readonly clear: () => void
}

/** An uploaded file as the kernel hands it over: a path under `.incoming/`. */
export interface IncomingFile {
  readonly path: string
  readonly bytes: number
}

export interface Mockups {
  readonly setup: () => MockupsSetup
  /** Not archived, newest first; the screen orders them (`client/model.ts`). */
  readonly list: () => readonly Mockup[]
  readonly get: (id: string) => Mockup | undefined
  readonly projects: () => Promise<Result<readonly ProjectEntry[]>>
  readonly create: (input: unknown) => Promise<Result<Created>>
  readonly siteMatch: (id: string, input: unknown) => Promise<Result<{ readonly siteId: string | null }>>
  readonly setSite: (id: string, input: unknown) => Promise<Result<Mockup>>
  readonly addInput: (id: string, file: IncomingFile, query: Readonly<Record<string, string>>) => Promise<Result<Mockup>>
  readonly addNote: (id: string, input: unknown) => Promise<Result<Mockup>>
  readonly docs: (id: string, stage: string) => Promise<Result<{ readonly files: readonly DocFile[] }>>
  readonly startRun: (id: string, input: unknown) => Promise<Result<RunTicket>>
  readonly decide: (id: string, input: unknown) => Promise<Result<Decided>>
  readonly archive: (id: string) => Promise<Result<Mockup>>
  readonly linkRun: (runId: string, input: unknown) => Promise<Result<Mockup>>
  readonly stallRun: (runId: string) => Promise<Result<Mockup>>
  readonly abandonRun: (runId: string, input: unknown) => Promise<Result<Mockup>>
  readonly agent: AgentToolImpl
  readonly stop: () => Promise<void>
}

export interface MockupsDeps {
  /** RAW: the module carries it as `z.unknown()`; the one schema lives here (D8). */
  readonly config: unknown
  readonly stateDir: string
  readonly log: Logger
  readonly now: () => Date
  readonly timers: Timers
  readonly notify: Notifier
  /** The seam for the tests: `os.homedir()` otherwise. */
  readonly home?: string
  /** As `sessions` compares paths: without case on macOS. The tests set it. */
  readonly caseInsensitive?: boolean
}

export type CreateMockupsResult = { readonly ok: true; readonly mockups: Mockups } | { readonly ok: false; readonly reason: string }

export type CreateMockups = (deps: MockupsDeps) => Promise<CreateMockupsResult>
