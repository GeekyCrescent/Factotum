/**
 * The shape of the capability this module consumes, DECLARED HERE AND NOWHERE ELSE IN THIS MODULE
 * (spec 2026-11-12-maquetas, D1) — the arrangement of `modules/tasks/types.ts`, whose header explains
 * it. Imports nothing but `@factotum/core` (CLAUDE.md §1; criterion 43). The two declarations meet at
 * one assignment in `packages/cli/src/main.ts`.
 *
 * The screen imports the DATA shapes from here too (`client/`): they are what the routes answer.
 *
 * MEMBERS ARE FUNCTION-TYPED PROPERTIES, never method syntax.
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

export interface Decision {
  readonly at: string
  readonly action: 'approve' | 'choose' | 'redo'
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
  readonly redo?: { readonly comment: string; readonly fromVersion: number }
}

export interface Step {
  readonly status: StepStatus
  readonly version: number
  readonly run?: Run
  readonly options?: readonly StageOption[]
  readonly chosen?: string
  readonly pendingComment?: string
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
  readonly kind: string
  readonly bytes: number
  readonly private: boolean
  readonly at: string
}

export interface Mockup {
  readonly id: string
  readonly name: string
  readonly client: string
  readonly project: string
  readonly vaultDir: string
  readonly workDir: string
  readonly buildSiteId: string | null
  readonly buildRefused?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly stages: Readonly<Record<StageId, Step>>
  readonly changes: readonly Change[]
  readonly inputs: readonly InputRef[]
  readonly urls: { readonly preview?: string; readonly prod?: string }
  readonly status: 'open' | 'delivered' | 'changing' | 'archived'
}

export type MockupError =
  | { readonly code: 'invalid'; readonly field: string; readonly reason: string }
  | { readonly code: 'not-found'; readonly reason: string }
  | { readonly code: 'conflict'; readonly reason: string }
  | { readonly code: 'too-large'; readonly reason: string }
  | { readonly code: 'module-error'; readonly reason: string }
  | { readonly code: 'not-yet'; readonly reason: string }

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: MockupError }

export interface ProjectEntry {
  readonly slug: string
  readonly title: string
  readonly workDir: string | null
}

export interface MockupsSetup {
  readonly docsSiteId: string
  readonly projectsDir: string
  readonly workRoot: string
  readonly crossWritesAllowed: boolean
}

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
  readonly mapWarning?: string
}

export interface Decided {
  readonly mockup: Mockup
  readonly run?: RunTicket
}

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

export interface MockupsLink {
  readonly family: AgentToolImpl
  readonly fill: (impl: AgentToolImpl) => void
  readonly clear: () => void
}

export interface IncomingFile {
  readonly path: string
  readonly bytes: number
}

export interface Mockups {
  readonly setup: () => MockupsSetup
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

/** What `start` hands to the factory. The config is RAW: the one schema lives in the package. */
export interface MockupsDeps {
  readonly config: unknown
  readonly stateDir: string
  readonly log: Logger
  readonly now: () => Date
  readonly timers: Timers
  readonly notify: Notifier
}

export type CreateMockupsResult = { readonly ok: true; readonly mockups: Mockups } | { readonly ok: false; readonly reason: string }

export type CreateMockups = (deps: MockupsDeps) => Promise<CreateMockupsResult>

/** A COPY of the package's `UPLOAD_MAX_BYTES` (criterion 9): the kernel needs it before any start. */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024
