/**
 * What a batch of questions IS, and what an answer to one is (spec 2026-10-01-preguntas-con-opciones, D1).
 *
 * Whoever fills these fields in is a language model, not a form: it is the least bounded input in the
 * whole system, and it lands in an append-only log that is never rewritten. This file decides what is
 * forgiven and what is not. The knowledge is the predecessor's (`preguntas.ts` in Jarvis); the code is not.
 *
 * GOING OVER A LIMIT IS CLIPPED, NOT REFUSED. Refusing a 300-character question leaves the agent unable
 * to ask, and then it asks in plain text — exactly what this feature exists to stop. A clipped question
 * is still a decision the owner can take.
 *
 * WHAT IS REFUSED is what cannot be fixed without inventing: no questions, too many, a question with
 * fewer than two options or without text. Filling those in ourselves would put an option in front of the
 * owner that nobody wrote.
 *
 * IDS ARE FILLED IN. They are plumbing — they exist so an answer does not depend on order — and asking
 * the model for them is asking it not to get wrong the one thing it does not care about.
 *
 * `modules/` cannot import this file (CLAUDE.md §1). Its types are declared again in
 * `modules/sessions/types.ts`, tied to these by the assignment in `packages/cli` (design D6 bis).
 */

import { z } from 'zod'

/** A longer batch stops being a decision and becomes a form. */
export const MAX_QUESTIONS = 6
/** A menu of one option is a notice, not a decision. */
export const MIN_OPTIONS = 2
/** Six 44-px options is what fits in the sheet at 360 px (the predecessor measured it). */
export const MAX_OPTIONS = 6
// The text limits are the predecessor's (Jarvis `packages/core/src/types.ts`), not reinvented.
export const MAX_QUESTION_CHARS = 280
export const MAX_LABEL_CHARS = 60
export const MAX_DESCRIPTION_CHARS = 200
/** What the owner types in "Other…". */
export const MAX_FREE_TEXT_CHARS = 500
/** Ids the agent makes up: bounded like everything that comes from outside. */
export const MAX_ID_CHARS = 64

const id = z.string().min(1).max(MAX_ID_CHARS)

export const optionSchema = z.object({
  id,
  label: z.string().min(1).max(MAX_LABEL_CHARS),
  description: z.string().min(1).max(MAX_DESCRIPTION_CHARS).optional(),
})

export const questionSchema = z.object({
  id,
  text: z.string().min(1).max(MAX_QUESTION_CHARS),
  options: z.array(optionSchema).min(MIN_OPTIONS).max(MAX_OPTIONS),
  multiple: z.boolean(),
})

export const answerSchema = z.discriminatedUnion('kind', [
  z.object({ question: id, kind: z.literal('chosen'), options: z.array(id).min(1).max(MAX_OPTIONS) }),
  z.object({ question: id, kind: z.literal('text'), text: z.string().min(1).max(MAX_FREE_TEXT_CHARS) }),
  z.object({ question: id, kind: z.literal('none') }),
])

export type QuestionOption = z.infer<typeof optionSchema>
export type Question = z.infer<typeof questionSchema>
export type Answer = z.infer<typeof answerSchema>

type Refusal = { readonly error: string }

/**
 * Cuts `text` to at most `maxUnits` UTF-16 units WITHOUT splitting a character.
 *
 * The two obvious ways are both broken, each in its own direction — the predecessor paid for this twice:
 * `slice(0, n)` splits a surrogate pair and leaves half an emoji; `[...s].slice(0, n)` counts code points,
 * and 80 emoji are 160 units, which zod's `.max(80)` refuses. So: walk code points, budget in units, and
 * stop BEFORE a character that does not fit whole.
 */
export function clipUnits(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text
  let out = ''
  for (const char of text) {
    if (out.length + char.length > maxUnits) break
    out += char
  }
  return out
}

function textOf(value: unknown, max: number): string {
  return typeof value === 'string' ? clipUnits(value.trim(), max) : ''
}

/** The agent's id if it is usable and unseen; otherwise `fallback`. Records whichever it returns. */
function claim(raw: unknown, fallback: string, seen: Set<string>): string {
  const own = typeof raw === 'string' ? raw.trim() : ''
  const chosen = own !== '' && own.length <= MAX_ID_CHARS && !seen.has(own) ? own : fallback
  seen.add(chosen)
  return chosen
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

/** Clips and fills in ids. What cannot be fixed without inventing comes back as `{ error }`, with why. */
export function sanitize(raw: unknown): readonly Question[] | Refusal {
  const questions = asArray(field(raw, 'questions'))
  if (questions === undefined || questions.length === 0) {
    return { error: 'Ask at least one question, each with at least two options.' }
  }
  if (questions.length > MAX_QUESTIONS) {
    return { error: `A batch takes up to ${MAX_QUESTIONS} questions; ${questions.length} arrived. Split the decision in two.` }
  }

  const questionIds = new Set<string>()
  const out: Question[] = []
  for (const [index, rawQuestion] of questions.entries()) {
    const text = textOf(field(rawQuestion, 'text'), MAX_QUESTION_CHARS)
    if (text === '') return { error: `Question ${index + 1} has no text.` }

    const options = asArray(field(rawQuestion, 'options')) ?? []
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return { error: `The question "${text}" needs between ${MIN_OPTIONS} and ${MAX_OPTIONS} options; it has ${options.length}.` }
    }

    const optionIds = new Set<string>()
    const cleanOptions: QuestionOption[] = []
    for (const [optionIndex, rawOption] of options.entries()) {
      const label = textOf(field(rawOption, 'label'), MAX_LABEL_CHARS)
      if (label === '') return { error: `Option ${optionIndex + 1} of "${text}" has no label.` }
      const description = textOf(field(rawOption, 'description'), MAX_DESCRIPTION_CHARS)
      cleanOptions.push({
        id: claim(field(rawOption, 'id'), `o${optionIndex + 1}`, optionIds),
        label,
        ...(description === '' ? {} : { description }),
      })
    }

    out.push({
      id: claim(field(rawQuestion, 'id'), `q${index + 1}`, questionIds),
      text,
      options: cleanOptions,
      multiple: field(rawQuestion, 'multiple') === true,
    })
  }
  return out
}

/**
 * The owner's answer, judged AGAINST ITS OWN BATCH — an option id is only meaningful inside its question.
 * One answer per question at most; a question with none in the body is an explicit `none`. The result is
 * in the order of the batch, whatever order the body used.
 */
export function parseAnswers(questions: readonly Question[], body: unknown): readonly Answer[] | Refusal {
  const sent = asArray(field(body, 'answers'))
  if (sent === undefined) return { error: 'The body must be { answers: [...] }.' }

  const byQuestion = new Map<string, Answer>()
  for (const raw of sent) {
    const questionId = field(raw, 'question')
    const question = questions.find((q) => q.id === questionId)
    if (question === undefined) return { error: `Question "${String(questionId)}" is not in this batch.` }
    if (byQuestion.has(question.id)) return { error: `"${question.text}" was answered twice.` }

    const judged = judge(question, raw)
    if ('error' in judged) return judged
    byQuestion.set(question.id, judged)
  }

  return questions.map((q) => byQuestion.get(q.id) ?? { question: q.id, kind: 'none' })
}

function judge(question: Question, raw: unknown): Answer | Refusal {
  const kind = field(raw, 'kind')
  if (kind === 'none') return { question: question.id, kind: 'none' }

  if (kind === 'text') {
    const text = textOf(field(raw, 'text'), MAX_FREE_TEXT_CHARS)
    if (text === '') return { error: `The free text for "${question.text}" is empty; send no answer instead.` }
    return { question: question.id, kind: 'text', text }
  }

  if (kind === 'chosen') {
    const chosen = asArray(field(raw, 'options'))
    if (chosen === undefined) return { error: `The answer to "${question.text}" lists no options.` }
    // Zero chosen is "did not choose", which is exactly what `none` says. Not an error.
    if (chosen.length === 0) return { question: question.id, kind: 'none' }
    if (!question.multiple && chosen.length > 1) {
      return { error: `"${question.text}" takes one option; ${chosen.length} were sent.` }
    }
    const ids = new Set(question.options.map((o) => o.id))
    const unknown = chosen.find((c) => typeof c !== 'string' || !ids.has(c))
    if (unknown !== undefined) return { error: `"${String(unknown)}" is not an option of "${question.text}".` }
    const unique = [...new Set(chosen as string[])]
    return { question: question.id, kind: 'chosen', options: unique }
  }

  return { error: `Unknown answer kind "${String(kind)}" for "${question.text}".` }
}
