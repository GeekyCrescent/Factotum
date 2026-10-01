/**
 * A batch of questions on the owner's screen, without the screen (spec 2026-10-01-preguntas-con-opciones,
 * D11): the draft, the body that is sent, the keyboard, and what the dock says. Pure; no DOM, so
 * `node --test` runs it.
 *
 * THE DRAFT IS IMMUTABLE. Every function returns a new one; the old one is untouched. The sheet can be
 * closed by an ask, by Escape or by Back and opened again without losing anything, because the area
 * holds the draft and the sheet only shows it.
 *
 * A GAP IS SAID, NOT LEFT OUT. The body carries an explicit `none` for every question without an answer,
 * and the engine tells the agent `"unanswered": true`: nobody chose, and nothing is to be assumed.
 */

import type { Answer, Question, SettledHow } from '../types.ts'

interface Entry {
  /** Which of the two the answer is right now. */
  readonly mode: 'chosen' | 'text'
  readonly chosen: readonly string[]
  /** What is in the "Other…" field, as typed. Kept when a choice takes over, so the field does not empty. */
  readonly text: string
}

export interface Draft {
  readonly byQuestion: ReadonlyMap<string, Entry>
}

const EMPTY: Entry = { mode: 'chosen', chosen: [], text: '' }

export function emptyDraft(questions: readonly Question[]): Draft {
  return { byQuestion: new Map(questions.map((q) => [q.id, EMPTY])) }
}

function entryOf(draft: Draft, questionId: string): Entry {
  return draft.byQuestion.get(questionId) ?? EMPTY
}

function withEntry(draft: Draft, questionId: string, entry: Entry): Draft {
  const next = new Map(draft.byQuestion)
  next.set(questionId, entry)
  return { byQuestion: next }
}

/** Single: the option replaces whatever was there. Multiple: it toggles. Either way a choice beats the text. */
export function choose(draft: Draft, question: Question, optionId: string): Draft {
  if (!question.options.some((o) => o.id === optionId)) return draft
  const entry = entryOf(draft, question.id)
  const current = entry.mode === 'chosen' ? entry.chosen : []
  const chosen = !question.multiple
    ? [optionId]
    : current.includes(optionId)
      ? current.filter((id) => id !== optionId)
      : question.options.map((o) => o.id).filter((id) => id === optionId || current.includes(id))
  return withEntry(draft, question.id, { ...entry, mode: 'chosen', chosen })
}

/** Text that says something replaces the choice. Blank text is no answer: the choice, if any, stays. */
export function writeText(draft: Draft, questionId: string, text: string): Draft {
  const entry = entryOf(draft, questionId)
  if (text.trim() !== '') return withEntry(draft, questionId, { mode: 'text', chosen: [], text })
  return withEntry(draft, questionId, { ...entry, mode: 'chosen', text })
}

export function textOf(draft: Draft, questionId: string): string {
  return entryOf(draft, questionId).text
}

export function isChosen(draft: Draft, questionId: string, optionId: string): boolean {
  const entry = entryOf(draft, questionId)
  return entry.mode === 'chosen' && entry.chosen.includes(optionId)
}

function answerOf(draft: Draft, questionId: string): Answer {
  const entry = entryOf(draft, questionId)
  if (entry.mode === 'text' && entry.text.trim() !== '') return { question: questionId, kind: 'text', text: entry.text.trim() }
  if (entry.mode === 'chosen' && entry.chosen.length > 0) return { question: questionId, kind: 'chosen', options: entry.chosen }
  return { question: questionId, kind: 'none' }
}

export function answeredCount(draft: Draft): number {
  return [...draft.byQuestion.keys()].filter((id) => answerOf(draft, id).kind !== 'none').length
}

/** What is sent: one answer per question, in the order of the batch, with the gaps as explicit `none`. */
export function body(draft: Draft, questions: readonly Question[]): { readonly answers: readonly Answer[] } {
  return { answers: questions.map((q) => answerOf(draft, q.id)) }
}

/** Sending with gaps is allowed, on purpose; the button says so. */
export function sendLabel(draft: Draft, questions: readonly Question[]): string {
  const left = body(draft, questions).answers.filter((a) => a.kind === 'none').length
  return left === 0 ? 'Send' : `Send (${left} unanswered)`
}

// --- the keyboard (criterion 31) --------------------------------------------------

/** Which question, and which row of it. `option === options.length` is "Other…". */
export interface Focus {
  readonly question: number
  readonly option: number
}

/** A key, without the DOM. */
export interface KeyInput {
  readonly key: string
  readonly keyCode: number
  readonly shiftKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly isComposing: boolean
}

export interface KeyOutcome {
  readonly draft: Draft
  readonly focus: Focus
  /** ⌘/Ctrl+Enter. */
  readonly send: boolean
  /** The key was this sheet's: prevent its default. */
  readonly handled: boolean
  /** Space/Enter on "Other…": focus its field. */
  readonly editText: boolean
  /** Escape inside the field: back to the options. */
  readonly leaveText: boolean
}

/**
 * ↑/↓ move between options, 1–6 choose in the current question, Space/Enter choose or toggle, Tab and
 * Shift+Tab move between questions, ⌘/Ctrl+Enter sends. INSIDE THE FREE TEXT only ⌘/Ctrl+Enter and
 * Escape are ours — the rest is typing. During IME composition (or `keyCode 229`, as `picker.tsx`
 * reads it) nothing is.
 */
export function onKey(questions: readonly Question[], draft: Draft, focus: Focus, input: KeyInput, inText: boolean): KeyOutcome {
  const none: KeyOutcome = { draft, focus, send: false, handled: false, editText: false, leaveText: false }
  if (input.isComposing || input.keyCode === 229) return none
  const done = (patch: Partial<KeyOutcome>): KeyOutcome => ({ ...none, handled: true, ...patch })

  if (input.key === 'Enter' && (input.metaKey || input.ctrlKey)) return done({ send: true })
  if (inText) return input.key === 'Escape' ? done({ leaveText: true }) : none

  const question = questions[focus.question]
  if (question === undefined) return none
  const other = question.options.length

  if (input.key === 'ArrowDown') return done({ focus: { ...focus, option: Math.min(focus.option + 1, other) } })
  if (input.key === 'ArrowUp') return done({ focus: { ...focus, option: Math.max(focus.option - 1, 0) } })

  if (input.key === 'Tab') {
    const next = focus.question + (input.shiftKey ? -1 : 1)
    if (next < 0 || next >= questions.length) return none
    return done({ focus: { question: next, option: 0 } })
  }

  if (/^[1-6]$/.test(input.key)) {
    const index = Number(input.key) - 1
    const option = question.options[index]
    if (option === undefined) return none
    return done({ draft: choose(draft, question, option.id), focus: { ...focus, option: index } })
  }

  if (input.key === ' ' || input.key === 'Enter') {
    if (focus.option >= other) return done({ editText: true })
    const option = question.options[focus.option]
    return option === undefined ? none : done({ draft: choose(draft, question, option.id) })
  }

  return none
}

// --- who asked, and what the dock says ------------------------------------------

/** "asked by general-purpose" when the log has the subagent's start; the main agent asked nobody's name. */
export function askedBy(task: string | undefined, agents: ReadonlyMap<string, string>): string | undefined {
  if (task === undefined) return undefined
  const agent = agents.get(task)
  return agent === undefined ? 'asked by a subagent' : `asked by ${agent}`
}

/** What reading the batch by its token came to, as the area knows it. */
export type BatchLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'no-token' }
  | { readonly kind: 'over'; readonly how: SettledHow }
  | { readonly kind: 'unknown' }

/**
 * Whether the sheet may open, and what the notice in the dock says. After answering, the URL that
 * brought the token is still there (`view.search` lives until the first navigation), so the area reads
 * the batch again and gets 409 `answered`: it says "Answered" and does NOT open the sheet again.
 */
export function sheetState(load: BatchLoad): { readonly opens: boolean; readonly notice: string } {
  switch (load.kind) {
    case 'pending':
      return { opens: true, notice: 'Questions for you' }
    case 'loading':
      return { opens: false, notice: 'Questions for you' }
    case 'no-token':
      return { opens: false, notice: 'Answer from the notification' }
    case 'unknown':
      return { opens: false, notice: 'These questions are over' }
    case 'over':
      switch (load.how) {
        case 'answered':
          return { opens: false, notice: 'Answered' }
        case 'expired':
          return { opens: false, notice: 'These questions expired' }
        case 'cancelled':
          return { opens: false, notice: 'These questions were cancelled' }
      }
  }
}
