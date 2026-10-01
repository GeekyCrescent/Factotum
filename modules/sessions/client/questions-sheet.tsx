/**
 * A batch of questions on the screen (spec 2026-10-01-preguntas-con-opciones, D12): reading it by its
 * token, answering it, and the sheet. What is pure — the draft, the keys, what the dock says — is in
 * `questions.ts`; this file only wires it to the DOM.
 *
 * THE AGENT'S TEXT IS PAINTED AS TEXT (guardrail 4): no Markdown here, nothing that turns a string into
 * markup. A question is a string in a <legend>, an option a string in a <button>.
 *
 * NO CONSOLE, anywhere here: the token passes through this file.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { Question } from '../types.ts'
import type { Api } from './contract.ts'
import { messageOf } from './errors.ts'
import { createGuard } from './guard.ts'
import { Icon } from './icon.tsx'
import {
  answerPath,
  answeredCount,
  body,
  choose,
  howOf,
  isChosen,
  onKey,
  sendLabel,
  textOf,
  writeText,
  type BatchLoad,
  type Draft,
  type Focus,
} from './questions.ts'
import type { QuestionsRef } from './relevance.ts'
import { Sheet } from './sheet.tsx'

/** What `GET questions/:token` answers while the batch waits. */
export interface BatchInfo {
  readonly sessionId: string
  readonly siteId: string
  readonly id: string
  readonly questions: readonly Question[]
  readonly task: string | null
  readonly deadlineAt: string
}

export interface Batch {
  readonly load: BatchLoad
  readonly info: BatchInfo | undefined
  /** Why it could not be read, when that is not because it is over. */
  readonly failure: string | undefined
  /** Throws what the owner has to read (a 400, the network); an end it records as `over`. */
  readonly send: (draft: Draft) => Promise<void>
}

const statusOf = (cause: unknown) => (cause as { status?: number } | undefined)?.status

/**
 * Reads the batch once and answers it. With a token (the notification brought it), by the token; WITHOUT
 * one, by the session and the batch's public id — the screen route (2026-10-02). Whatever ends it also
 * ends its pending.
 */
export function useBatch(api: Api, ref: QuestionsRef, resolvePending: (tag: string) => void): Batch {
  const [load, setLoad] = useState<BatchLoad>({ kind: 'loading' })
  const [info, setInfo] = useState<BatchInfo | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const resolve = useRef(resolvePending)
  resolve.current = resolvePending

  const ended = (next: BatchLoad) => {
    setLoad(next)
    resolve.current(ref.tag)
  }

  useEffect(() => {
    const token = ref.token
    let live = true
    setLoad({ kind: 'loading' })
    const read: Promise<BatchInfo | undefined> =
      token !== undefined
        ? api.get<BatchInfo>(`questions/${token}`)
        : api
            .get<{ batches: readonly Omit<BatchInfo, 'sessionId'>[] }>(`sessions/${ref.sessionId}/questions`)
            .then((got) => {
              const found = got.batches.find((b) => b.id === ref.batch)
              return found === undefined ? undefined : { ...found, sessionId: ref.sessionId }
            })
    read
      .then((got) => {
        if (!live) return
        // Not among the session's open batches any more: it is over, and the log says how.
        if (got === undefined) return ended({ kind: 'unknown' })
        setInfo(got)
        setLoad({ kind: 'pending' })
      })
      .catch((cause: unknown) => {
        if (!live) return
        const how = howOf(cause)
        if (how !== undefined) return ended({ kind: 'over', how })
        if (statusOf(cause) === 404) return ended({ kind: 'unknown' })
        setFailure(messageOf(cause))
      })
    return () => {
      live = false
    }
  }, [api, ref.token, ref.tag])

  const send = async (draft: Draft) => {
    if (info === undefined) return
    try {
      await api.post(answerPath(ref), body(draft, info.questions))
      ended({ kind: 'over', how: 'answered' })
    } catch (cause: unknown) {
      const how = howOf(cause)
      if (how !== undefined) return ended({ kind: 'over', how })
      if (statusOf(cause) === 404) return ended({ kind: 'unknown' })
      throw cause
    }
  }

  return { load, info, failure, send }
}

export function QuestionsSheet({
  info,
  draft,
  setDraft,
  by,
  send,
  onClose,
}: {
  readonly info: BatchInfo
  readonly draft: Draft
  readonly setDraft: (draft: Draft) => void
  /** "asked by general-purpose", or nothing for the main agent. */
  readonly by: string | undefined
  readonly send: () => Promise<void>
  readonly onClose: () => void
}) {
  const { questions } = info
  const root = useRef<HTMLDivElement>(null)
  const [focus, setFocus] = useState<Focus>({ question: 0, option: 0 })
  // Which "Other…" fields are open. One that already holds text opens with it.
  const [writing, setWriting] = useState<ReadonlySet<string>>(() => new Set(questions.filter((q) => textOf(draft, q.id) !== '').map((q) => q.id)))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const guard = useRef(createGuard(() => performance.now()))
  const pressedAt = useRef<number | undefined>(undefined)

  useEffect(() => {
    const frame = requestAnimationFrame(() => guard.current.shown())
    return () => cancelAnimationFrame(frame)
  }, [])

  const place = (target: Focus, text = false) => {
    setFocus(target)
    const selector = text ? `[data-text="${target.question}"]` : `[data-q="${target.question}"][data-o="${target.option}"]`
    // After the render that may have just opened the field.
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(selector)?.focus())
  }

  const submit = async (pointerDownAt: number | undefined) => {
    if (busy || !guard.current.accepts(pointerDownAt)) return
    setBusy(true)
    setFailure(undefined)
    try {
      await send()
    } catch (cause: unknown) {
      setFailure(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const openText = (question: Question, index: number) => {
    setWriting(new Set([...writing, question.id]))
    place({ question: index, option: question.options.length }, true)
  }

  const keyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null
    const inText = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT'
    const out = onKey(questions, draft, focus, event, inText)
    if (!out.handled) return
    event.preventDefault()
    // Escape inside the field is the field's: it must not reach the sheet and close it.
    event.stopPropagation()
    if (out.draft !== draft) setDraft(out.draft)
    if (out.send) return void submit(undefined)
    const question = questions[out.focus.question]
    if (out.editText && question !== undefined) return openText(question, out.focus.question)
    // While the field is open it stands where "Other…" was: back to the option above it.
    if (out.leaveText && question !== undefined) return place({ ...out.focus, option: Math.max(0, question.options.length - 1) })
    place(out.focus)
  }

  const answered = answeredCount(draft)
  const title = questions.length === 1 ? '1 question' : `${questions.length} questions`

  return (
    <Sheet id="s-q-title" title={title} onClose={onClose}>
      <p class="s-q-meta">
        {by === undefined ? null : <span class="s-q-by">{by} · </span>}
        <span class="num">
          {answered} of {questions.length} answered
        </span>
      </p>
      <div class="s-qs" ref={root} onKeyDown={keyDown}>
        {questions.map((question, qi) => {
          const isFocusedQuestion = focus.question === qi
          const other = question.options.length
          return (
            <fieldset key={question.id} class="s-q">
              <legend class="s-q-text">
                {questions.length > 1 ? (
                  <span class="s-q-num num" aria-hidden="true">
                    {qi + 1}
                  </span>
                ) : null}
                <span>{question.text}</span>
              </legend>
              <div class="s-opts" role={question.multiple ? 'group' : 'radiogroup'} aria-label={question.text}>
                {question.options.map((option, oi) => {
                  const chosen = isChosen(draft, question.id, option.id)
                  const tabbable = isFocusedQuestion ? focus.option === oi : oi === 0
                  return (
                    <button
                      key={option.id}
                      type="button"
                      class={chosen ? 's-opt is-on' : 's-opt'}
                      role={question.multiple ? 'checkbox' : 'radio'}
                      aria-checked={chosen}
                      tabIndex={tabbable ? 0 : -1}
                      // The keys work from the first option on: the sheet focuses it instead of its title.
                      autofocus={qi === 0 && oi === 0}
                      data-q={qi}
                      data-o={oi}
                      onFocus={() => setFocus({ question: qi, option: oi })}
                      onClick={() => setDraft(choose(draft, question, option.id))}
                    >
                      <span class="s-opt-mark" aria-hidden="true">
                        {question.multiple ? <Icon name={chosen ? 'check-square' : 'square'} size={18} /> : <span class="s-radio" />}
                      </span>
                      <span class="s-opt-text">
                        <span class="s-opt-label">{option.label}</span>
                        {option.description === undefined ? null : <span class="s-opt-desc">{option.description}</span>}
                      </span>
                      {oi < 6 ? (
                        <kbd class="s-opt-key num" aria-hidden="true">
                          {oi + 1}
                        </kbd>
                      ) : null}
                    </button>
                  )
                })}
                {writing.has(question.id) ? (
                  <textarea
                    class="s-q-other"
                    rows={2}
                    maxLength={500}
                    placeholder="Your answer, in your words"
                    aria-label={`Other answer to: ${question.text}`}
                    data-text={qi}
                    value={textOf(draft, question.id)}
                    onFocus={() => setFocus({ question: qi, option: other })}
                    onInput={(event) => setDraft(writeText(draft, question.id, (event.target as HTMLTextAreaElement).value))}
                  />
                ) : (
                  <button
                    type="button"
                    class="s-opt s-opt-other"
                    tabIndex={isFocusedQuestion && focus.option === other ? 0 : -1}
                    data-q={qi}
                    data-o={other}
                    onFocus={() => setFocus({ question: qi, option: other })}
                    onClick={() => openText(question, qi)}
                  >
                    <span class="s-opt-mark" aria-hidden="true">
                      <Icon name="pencil-simple" size={18} />
                    </span>
                    <span class="s-opt-text">
                      <span class="s-opt-label">Other…</span>
                    </span>
                  </button>
                )}
              </div>
            </fieldset>
          )
        })}
      </div>
      {failure === undefined ? null : (
        <p class="s-error" role="alert">
          {failure}
        </p>
      )}
      <div class="s-q-send">
        <span class="s-q-hint dim-3">⌘↵ to send</span>
        <button
          type="button"
          class="btn primary"
          disabled={busy}
          onPointerDown={() => {
            pressedAt.current = performance.now()
          }}
          onClick={() => {
            const at = pressedAt.current
            pressedAt.current = undefined
            void submit(at)
          }}
        >
          {sendLabel(draft, questions)}
        </button>
      </div>
    </Sheet>
  )
}
