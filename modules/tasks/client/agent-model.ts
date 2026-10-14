/**
 * What the task screen computes about the sessions module, PURE so `node --test` reaches it (design
 * D9; criteria 22, 30–32): which entry «Run agent» launches with, the prompt it starts from, why a
 * launch failed, what a linked session is doing, and the projects a capture may be filed under.
 *
 * THE SESSIONS MODULE IS READ BY STRUCTURE: `SetupView` is the part of its `GET setup` this screen
 * reads, declared here, never imported (criterion 44).
 */

import type { Task } from '../types.ts'
import { conflictOf, describe, freshnessOf, launchUnanswered } from './launch-errors.ts'
import { messageOf, statusOf } from './model.ts'
import { toStoredHost, type Where } from './where.ts'

/** The part of the sessions module's `GET setup` this screen reads. `kind` is absent on older builds. */
export interface SetupView {
  readonly sites: readonly { readonly id: string; readonly name: string | undefined; readonly status: 'ok' | 'missing' }[]
  readonly catalog: readonly {
    readonly id: string
    readonly label: string
    readonly disabledReason: string | undefined
    readonly kind?: string | undefined
  }[]
}

/** The first enabled entry whose kind is `none`: the free prompt. Never a command, never a subagent (crit. 30). */
export function freePromptEntry(catalog: SetupView['catalog']): string | undefined {
  return catalog.find((entry) => entry.kind === 'none' && entry.disabledReason === undefined)?.id
}

/** What the sheet starts from: the title, the notes, and the subtasks still open. The owner edits it. */
export function agentPrompt(task: Task): string {
  const open = task.subtasks.filter((subtask) => !subtask.done).map((subtask) => `- ${subtask.text}`)
  const parts = [task.title, task.notes.trim(), open.length === 0 ? '' : `Open subtasks:\n${open.join('\n')}`]
  return parts.filter((part) => part !== '').join('\n\n')
}

export type ProjectState = 'ok' | 'missing' | 'unknown'

export function projectState(setup: SetupView, siteId: string): ProjectState {
  const site = setup.sites.find((s) => s.id === siteId)
  return site === undefined ? 'unknown' : site.status
}

export type LaunchProblem =
  | { readonly kind: 'busy'; readonly sessionId: string }
  | { readonly kind: 'stale'; readonly detail: string }
  /** A launch on another host that came back 502: it may have started (crit. 31b). */
  | { readonly kind: 'unanswered' }
  | { readonly kind: 'rejected'; readonly message: string }

/** `host` in the client's language: `undefined` is the serving host. */
export function launchProblem(cause: unknown, host: string | undefined): LaunchProblem {
  const busy = conflictOf(cause)
  if (busy !== undefined) return { kind: 'busy', sessionId: busy.sessionId }
  const stale = freshnessOf(cause)
  if (stale !== undefined) return { kind: 'stale', detail: describe(stale) }
  if (launchUnanswered(cause, host)) return { kind: 'unanswered' }
  return { kind: 'rejected', message: messageOf(cause) }
}

export type LinkedState = 'running' | 'finished' | 'failed' | 'cancelled' | 'deleted' | 'unreachable' | 'unknown'

const STATES: readonly LinkedState[] = ['running', 'finished', 'failed', 'cancelled']

/** A read of `GET sessions/:id`: its answer, its failure, or `no-host` when that host is not in `hosts`. */
export type LinkedRead = { readonly ok: true; readonly value: { readonly state?: unknown } } | { readonly ok: false; readonly cause: unknown } | 'no-host'

export function linkedState(read: LinkedRead): LinkedState {
  if (read === 'no-host') return 'unreachable'
  if (!read.ok) return statusOf(read.cause) === 404 ? 'deleted' : 'unreachable'
  const state = read.value.state
  return STATES.find((s) => s === state) ?? 'unknown'
}

/** At most this many projects go with a capture (design D5, S12). */
export const MAX_CAPTURE_PROJECTS = 100

export interface CaptureProject {
  readonly host: string | null
  readonly siteId: string
  readonly name: string
}

/** Every project that is there, from every host that answered, with its host AS THE BOARD STORES IT. */
export function captureProjects(answers: readonly { readonly host: string | undefined; readonly setup: SetupView }[], where: Where): readonly CaptureProject[] {
  return answers
    .flatMap(({ host, setup }) =>
      setup.sites.filter((site) => site.status === 'ok').map((site) => ({ host: toStoredHost(host, where), siteId: site.id, name: site.name ?? site.id })),
    )
    .slice(0, MAX_CAPTURE_PROJECTS)
}
