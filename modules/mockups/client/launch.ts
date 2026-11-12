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
import type { RunKind, RunTicket, StageId } from '../types.ts'
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

/** Asks the module for a run with `post` (it answers the ticket, or `{ run }`), then launches it. */
async function ticketThenLaunch(apis: LaunchApis, post: () => Promise<RunTicket | undefined>, missing: string): Promise<LaunchOutcome> {
  if (apis.sessions === undefined) return NO_SESSIONS
  let ticket: RunTicket | undefined
  try {
    ticket = await post()
  } catch (cause) {
    return { ok: false, problem: { kind: 'rejected', message: messageOf(cause) } }
  }
  if (ticket === undefined) return { ok: false, problem: { kind: 'rejected', message: missing } }
  return await launchTicket(apis, ticket)
}

/** «Start» (and «Retry» after an abandon): create the run, then launch it. A change's run names its change. */
export async function startStage(apis: LaunchApis, mockupId: string, kind: RunKind, changeId?: string): Promise<LaunchOutcome> {
  const body = { kind, ...(changeId === undefined ? {} : { changeId }) }
  return await ticketThenLaunch(apis, () => apis.mockups.post<RunTicket>(`mockups/${encodeURIComponent(mockupId)}/runs`, body), 'the module started no run')
}

/** «Redo»: the decision with its comment creates the run (D6), then the same launch — at a stage's gate or a change's. */
export async function redoStage(apis: LaunchApis, mockupId: string, step: StageId | { readonly changeId: string }, comment: string): Promise<LaunchOutcome> {
  const path = `mockups/${encodeURIComponent(mockupId)}/decision`
  return await ticketThenLaunch(apis, async () => (await apis.mockups.post<{ run?: RunTicket }>(path, { step, action: 'redo', comment })).run, 'the redo did not start a run')
}

/** «Request a change» (criterion 36): the change and its run in one call, then the launch. */
export async function requestChange(apis: LaunchApis, mockupId: string, text: string): Promise<LaunchOutcome> {
  const path = `mockups/${encodeURIComponent(mockupId)}/changes`
  return await ticketThenLaunch(apis, async () => (await apis.mockups.post<{ run?: RunTicket }>(path, { text })).run, 'the change did not start a run')
}

export interface Notice {
  readonly text: string
  /** The session in the way of a busy launch, to open it (criterion 15). */
  readonly sessionId?: string
}

/** What the screen says after a launch; `undefined` when there is nothing to say. */
export function noticeOf(outcome: LaunchOutcome): Notice | undefined {
  if (outcome.ok) return outcome.titled ? undefined : { text: 'The session started, but its title could not be set.' }
  const p = outcome.problem
  switch (p.kind) {
    case 'busy':
      return { text: 'The project already has a session running, so the stage is back where it was.', sessionId: p.sessionId }
    case 'stale':
      return { text: `The project changed under the launch: ${p.detail}.` }
    case 'unanswered':
      return { text: 'That host did not answer in time. The session may have started; the stage will show it.' }
    case 'rejected':
      return { text: p.message }
  }
}
