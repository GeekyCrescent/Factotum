/**
 * The engine's side of the questions (spec 2026-10-01-preguntas-con-opciones, D5): the three facade
 * members, the held call, who asked, and who writes a batch's end.
 *
 * Its own file so `engine.ts` only wires it: the engine hands over what it knows (which sessions are
 * live, the store, the notifier) and calls back in at the three places a session ends.
 *
 * WHOEVER CLOSES A BATCH WRITES ITS `settled`, AND BEFORE THE TERMINAL STATE. The held call writes only
 * what it settled itself (answered, expired). A Cancel, a process that ends, or a stop close the batch
 * synchronously and queue the `settled` on the session's log right then — the store queues per session
 * at call time, so it lands before anything `finalize` writes after. Left to the waiter, it landed
 * after the terminal state: the audit measured exactly that (requirements §0.8 bis).
 */

import type { Logger, NotificationMessage, Notifier, Timers } from '@factotum/core'
import type { Callers } from '../callers.ts'
import { isSessionId } from '../id.ts'
import type { EventInput, OpenBatch, QuestionsAnswer, QuestionsInspect } from '../types.ts'
import { createBatchTable, type BatchAnswerResult, type BatchOutcome, type PendingBatch, type SettledHow } from './batches.ts'
import { NOT_RUNNING, resultFor, SHUTDOWN_TEXT, toolText, UNREACHABLE, type McpDeps, type ToolResult } from './mcp.ts'
import { parseAnswers, sanitize, type Answer } from './shape.ts'

export interface QuestionsDeps {
  readonly append: (sessionId: string, event: EventInput) => Promise<unknown>
  /** The live session's project, or `undefined` when it is not running in this daemon. */
  readonly siteOf: (sessionId: string) => string | undefined
  readonly isStopped: () => boolean
  readonly notify: Notifier
  readonly log: Logger
  readonly now: () => Date
  readonly timers: Timers
  /** The permissions' window: one knob (design D5). */
  readonly timeoutMs: number
  /** Who made a call, shared with the services (spec 2026-10-02, D8). The gate notes; this takes and cleans. */
  readonly callers: Callers
}

export interface Questions {
  /** The held call. The ENGINE mounts `handleMcp` with it and the services' tools (spec 2026-10-02, D7). */
  readonly askOwner: McpDeps['askOwner']
  readonly inspect: (token: string) => Promise<QuestionsInspect>
  readonly answer: (token: string, body: unknown) => Promise<QuestionsAnswer>
  /** Without a token, from a screen: by session, and by the batch's public id. */
  readonly inSession: (sessionId: string) => Promise<readonly OpenBatch[]>
  readonly answerInSession: (sessionId: string, batchId: string, body: unknown) => Promise<QuestionsAnswer>
  /**
   * Cancel, or a process that ended: closes the session's batches NOW and queues their `settled`.
   * Returns the writes, NOT awaited by the call itself — the caller decides when to wait.
   */
  readonly closeSession: (sessionId: string) => Promise<unknown>
  /** stop(): every batch as `shutdown`, its `settled` queued on each session's log. */
  readonly closeAll: (reason: string) => Promise<unknown>
}

/** The same judgement for both routes: the answer against ITS batch, then the table. */
function judged(
  found: PendingBatch | { readonly over: SettledHow } | undefined,
  body: unknown,
  answer: (answers: readonly Answer[]) => BatchAnswerResult,
): QuestionsAnswer {
  if (found === undefined) return { kind: 'unknown' }
  if ('over' in found) return found.over === 'answered' ? { kind: 'answered', first: false } : { kind: 'over', how: found.over }
  const answers = parseAnswers(found.questions, body)
  if ('error' in answers) return { kind: 'invalid', reason: answers.error }
  const result = answer(answers)
  switch (result.kind) {
    case 'answered':
      return { kind: 'answered', first: true }
    case 'already':
      return { kind: 'answered', first: false }
    case 'expired':
    case 'cancelled':
      return { kind: 'over', how: result.kind }
    case 'unknown':
      return { kind: 'unknown' }
  }
}

const plural = (n: number): string => `${n} question${n === 1 ? '' : 's'}`

export function createQuestions(deps: QuestionsDeps): Questions {
  const batches = createBatchTable({ now: deps.now, timers: deps.timers, timeoutMs: deps.timeoutMs })

  const settledEvent = (batch: PendingBatch, outcome: BatchOutcome): EventInput => ({
    kind: 'questions',
    phase: 'settled',
    id: batch.id,
    outcome: outcome.kind,
    ...(outcome.kind === 'answered' ? { answers: outcome.answers, via: outcome.via } : {}),
    ...(batch.task === undefined ? {} : { task: batch.task }),
  })

  const writeClosed = (closed: readonly PendingBatch[], outcome: BatchOutcome): Promise<unknown> =>
    Promise.all(closed.map((batch) => deps.append(batch.sessionId, settledEvent(batch, outcome))))

  function notice(batch: PendingBatch, token: string): NotificationMessage {
    const n = batch.questions.length
    return {
      title: 'questions',
      // The project and how many — NEVER the question: this leaves the tailnet (guardrail 5).
      body: `${batch.siteId} · ${plural(n)}`,
      // Per BATCH, so two batches of one session do not replace each other's notification.
      tag: `questions:${batch.sessionId}:${batch.id}`,
      // The public id rides along so the client can tell which pending this token belongs to (D10).
      path: `/m/sessions/${batch.sessionId}?questions=${token}&batch=${batch.id}`,
      data: { kind: 'questions', questionsId: token, batch: batch.id, sessionId: batch.sessionId, siteId: batch.siteId, count: n },
      until: batch.deadlineAt,
    }
  }

  /** The held call, in the order of the permission ask: open, THEN tell, then wait, then write. */
  async function askOwner(input: { sessionId: string; toolUseId: string | undefined; raw: unknown }): Promise<ToolResult> {
    if (deps.isStopped()) return toolText(SHUTDOWN_TEXT, true)
    const siteId = isSessionId(input.sessionId) ? deps.siteOf(input.sessionId) : undefined
    if (siteId === undefined) return toolText(NOT_RUNNING, true)
    if (!deps.notify.canReach()) return toolText(UNREACHABLE, true)

    const questions = sanitize(input.raw)
    if ('error' in questions) return toolText(questions.error, true)

    const task = deps.callers.take(input.toolUseId, input.sessionId)

    const { token, id, outcome, deadlineAt } = batches.open({ sessionId: input.sessionId, siteId, questions, task })
    const batch: PendingBatch = { id, sessionId: input.sessionId, siteId, questions, task, deadlineAt }
    await deps.append(input.sessionId, { kind: 'questions', phase: 'asked', id, questions, ...(task === undefined ? {} : { task }) })

    // FIRE AND FORGET, with its .catch: an unhandled rejection ends the process (see `announce`).
    void Promise.resolve()
      .then(() => deps.notify.send(notice(batch, token)))
      .catch((error: unknown) =>
        deps.log.warn(`a questions notice for session ${input.sessionId} could not be sent: ${error instanceof Error ? error.name : 'error'}`),
      )

    const settled = await outcome
    // Cancelled and shutdown were written by whoever closed the batch, before the terminal state.
    if (settled.kind === 'answered' || settled.kind === 'expired') await deps.append(input.sessionId, settledEvent(batch, settled))
    return resultFor(settled, questions)
  }

  return {
    askOwner,

    inspect: async (token) => {
      const found = batches.get(token)
      if (found === undefined) return { kind: 'unknown' }
      if ('over' in found) return { kind: 'over', how: found.over }
      return {
        kind: 'pending',
        sessionId: found.sessionId,
        siteId: found.siteId,
        id: found.id,
        questions: found.questions,
        task: found.task,
        deadlineAt: found.deadlineAt,
      }
    },

    answer: async (token, body) => judged(batches.get(token), body, (answers) => batches.answer(token, answers)),

    inSession: async (sessionId) =>
      batches.inSession(sessionId).map((batch) => ({
        id: batch.id,
        siteId: batch.siteId,
        questions: batch.questions,
        task: batch.task,
        deadlineAt: batch.deadlineAt,
      })),

    answerInSession: async (sessionId, batchId, body) =>
      judged(batches.byId(sessionId, batchId), body, (answers) => batches.answerById(sessionId, batchId, answers)),

    closeSession: (sessionId) => {
      deps.callers.forgetSession(sessionId)
      return writeClosed(batches.closeSession(sessionId), { kind: 'cancelled' })
    },

    closeAll: (reason) => {
      deps.callers.clear()
      return writeClosed(batches.closeAll(reason), { kind: 'shutdown', reason })
    },
  }
}
