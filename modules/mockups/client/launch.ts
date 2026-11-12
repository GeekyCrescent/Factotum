/**
 * Launching a stage's run from the screen (design D5; criteria 14, 15). The module cannot launch a
 * session from the server (requirements §0.2), so the screen does it, in this order:
 *
 * 1. `POST mockups/:id/runs` (or a redo's `POST decision`) → the run, its site, prompt and title;
 * 2. `POST sessions { siteId, entryId, text, model?, force: true }` — ALWAYS `force`: the module has
 *    just written in the vault (`_versions/`, hub, map) and without it `sessions` answers `409 stale`;
 * 3. `POST runs/:runId/session`, then `POST sessions/:id/title` (the titler would replace a first line);
 * 4. a refused launch → `POST runs/:runId/abandon`: the stage goes back where it was.
 *
 * A launch on ANOTHER host that came back 502 is NOT abandoned: it may have started, and its
 * `submit_stage` would be accepted (shared/launch-errors; criterion 18). The sweep stalls it if not.
 *
 * The abandon's reason is a status, never a message: it is logged, and a message can carry a path.
 */

import { conflictOf, describe, freshnessOf, launchUnanswered } from '../../shared/launch-errors/launch-errors.ts'
import type { RunTicket, StageId } from '../types.ts'
import type { Api } from './contract.ts'

export interface CatalogEntry {
  readonly id: string
  readonly label: string
  readonly disabledReason: string | undefined
  readonly kind?: string | undefined
}

/** A COPY of `freePromptEntry` (`modules/tasks/client/agent-model.ts`; D5): one line, declared. */
export function freePromptEntry(catalog: readonly CatalogEntry[]): string | undefined {
  return catalog.find((entry) => entry.kind === 'none' && entry.disabledReason === undefined)?.id
}

export type LaunchProblem =
  | { readonly kind: 'busy'; readonly sessionId: string }
  | { readonly kind: 'stale'; readonly detail: string }
  | { readonly kind: 'unanswered' }
  | { readonly kind: 'rejected'; readonly message: string }

export type LaunchOutcome =
  | { readonly ok: true; readonly sessionId: string; readonly titled: boolean }
  | { readonly ok: false; readonly problem: LaunchProblem }

export interface LaunchApis {
  readonly mockups: Api
  /** `sessions` on the host serving mockups; `undefined` when it does not run there (criterion 41). */
  readonly sessions: Api | undefined
  readonly host?: string | undefined
}

export function statusOf(cause: unknown): number | undefined {
  const status = (cause as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function problemOf(cause: unknown, host: string | undefined): LaunchProblem {
  const busy = conflictOf(cause)
  if (busy !== undefined) return { kind: 'busy', sessionId: busy.sessionId }
  const stale = freshnessOf(cause)
  if (stale !== undefined) return { kind: 'stale', detail: describe(stale) }
  if (launchUnanswered(cause, host)) return { kind: 'unanswered' }
  return { kind: 'rejected', message: messageOf(cause) }
}

const NO_SESSIONS: LaunchOutcome = { ok: false, problem: { kind: 'rejected', message: 'sessions is not running on this host' } }

async function abandon(mockups: Api, runId: string, reason: string): Promise<void> {
  // Best effort: if this fails too, the sweep stalls the run and «Retry» is offered.
  await mockups.post(`runs/${encodeURIComponent(runId)}/abandon`, { reason }).catch(() => undefined)
}

/** Steps 2–4 for a run the module has already created. */
export async function launchTicket(apis: LaunchApis, ticket: RunTicket): Promise<LaunchOutcome> {
  const { mockups, sessions } = apis
  if (sessions === undefined) {
    await abandon(mockups, ticket.runId, 'no sessions')
    return NO_SESSIONS
  }
  let entryId: string | undefined
  try {
    entryId = freePromptEntry((await sessions.get<{ catalog: readonly CatalogEntry[] }>('setup')).catalog)
  } catch (cause) {
    await abandon(mockups, ticket.runId, `setup unreadable (${statusOf(cause) ?? 'no status'})`)
    return { ok: false, problem: { kind: 'rejected', message: messageOf(cause) } }
  }
  if (entryId === undefined) {
    await abandon(mockups, ticket.runId, 'no free-prompt entry')
    return { ok: false, problem: { kind: 'rejected', message: 'this host has no free-prompt entry to launch with' } }
  }
  let sessionId: string
  try {
    const body = { siteId: ticket.siteId, entryId, text: ticket.text, force: true, ...(ticket.model === undefined ? {} : { model: ticket.model }) }
    sessionId = (await sessions.post<{ sessionId: string }>('sessions', body)).sessionId
  } catch (cause) {
    const problem = problemOf(cause, apis.host)
    if (problem.kind !== 'unanswered') await abandon(mockups, ticket.runId, `launch refused (${statusOf(cause) ?? 'no status'})`)
    return { ok: false, problem }
  }
  // Linked first: the run must know its session before anything else can fail.
  await mockups.post(`runs/${encodeURIComponent(ticket.runId)}/session`, { sessionId }).catch(() => undefined)
  const titled = await sessions
    .post(`sessions/${encodeURIComponent(sessionId)}/title`, { title: ticket.title })
    .then(() => true)
    .catch(() => false)
  return { ok: true, sessionId, titled }
}

/** «Start» (and «Retry» after an abandon): create the run, then launch it. */
export async function startStage(apis: LaunchApis, mockupId: string, kind: StageId): Promise<LaunchOutcome> {
  if (apis.sessions === undefined) return NO_SESSIONS
  let ticket: RunTicket
  try {
    ticket = await apis.mockups.post<RunTicket>(`mockups/${encodeURIComponent(mockupId)}/runs`, { kind })
  } catch (cause) {
    return { ok: false, problem: { kind: 'rejected', message: messageOf(cause) } }
  }
  return await launchTicket(apis, ticket)
}

/** «Redo»: the decision with its comment creates the run (D6), then the same launch. */
export async function redoStage(apis: LaunchApis, mockupId: string, step: StageId, comment: string): Promise<LaunchOutcome> {
  if (apis.sessions === undefined) return NO_SESSIONS
  let ticket: RunTicket | undefined
  try {
    ticket = (await apis.mockups.post<{ run?: RunTicket }>(`mockups/${encodeURIComponent(mockupId)}/decision`, { step, action: 'redo', comment })).run
  } catch (cause) {
    return { ok: false, problem: { kind: 'rejected', message: messageOf(cause) } }
  }
  if (ticket === undefined) return { ok: false, problem: { kind: 'rejected', message: 'the redo did not start a run' } }
  return await launchTicket(apis, ticket)
}
