/**
 * The review screen (spec 2026-11-12-postulaciones, design D15 «Revisión», mockup B v2
 * `maquetas/review-one-at-a-time-v2.html`; requirements crit. 28–38b).
 *
 * ONE ITEM FILLS THE SCREEN, under the bar «Jobs › Review · 2 of 10» with a dot per item. The buttons
 * are ← Back · Skip · Approve & next →; the keys `A`, `S`, `←` and `/` do the same (crit. 36). What is
 * on, what is off and why, is `model.ts`'s; this file only draws it and posts.
 *
 * WHERE THE SCREEN IS: the daemon keeps the batch and its results; the screen keeps only which item
 * it shows. It opens on the first undecided one from the batch's cursor, moves to the next undecided
 * after each decision, and «← Back» shows earlier items read-only with their result (crit. 35).
 *
 * APPROVE DOES NOT WAIT (D9): an email moves on as soon as the engine answers `sending`, and its line
 * in the bar follows the send (`use-sends.ts`).
 */

import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { BatchView, Decision, ReviewItem, ViewProps } from './contract.ts'
import { createLock } from './guard.ts'
import { approveGate, batchSummary, headerOf, keyAction, nextOpen, sendKeyOf, type SendKey } from './model.ts'
import { ReviewItemView, type ItemActions } from './review-item.tsx'
import { isRefusal, useBatch } from './use-batch.ts'
import { useSends, type TrackedSend } from './use-sends.ts'
import { useSettle } from './use-settle.ts'

/** The focus is somewhere typing goes: the keys are the text's, not the screen's. */
function isField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function Review({ props }: { readonly props: ViewProps }) {
  const { api, navigate } = props
  const { answer, error, clearError, start, decide } = useBatch(api)
  const sends = useSends(api)
  const batch = answer?.batch ?? null
  /** Which item is on screen, in which batch; -1 = none undecided left. */
  const [place, setPlace] = useState<{ readonly batchId: string; readonly index: number } | undefined>(undefined)
  /** After a decision went through: move on from this index once the batch is read again. */
  const [advanceFrom, setAdvanceFrom] = useState<number | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  /** For drawing only; the guard is `lock`, read synchronously by every decision (D15). */
  const [busy, setBusy] = useState(false)
  const lock = useMemo(createLock, [])
  const box = useRef<HTMLTextAreaElement>(null)

  // A batch seen for the first time opens on its first undecided item from the cursor.
  useEffect(() => {
    if (batch === null || place?.batchId === batch.id) return
    setPlace({ batchId: batch.id, index: nextOpen(batch, batch.cursor) })
  }, [batch, place])

  useEffect(() => {
    if (batch === null || advanceFrom === undefined) return
    setAdvanceFrom(undefined)
    setPlace({ batchId: batch.id, index: nextOpen(batch, advanceFrom + 1) })
  }, [batch, advanceFrom])

  // At the end of the batch, a rewrite that comes back (crit. 32) is brought to the screen.
  useEffect(() => {
    if (batch === null || place?.batchId !== batch.id || place.index !== -1) return
    const back = nextOpen(batch, 0)
    if (back !== -1) setPlace({ batchId: batch.id, index: back })
  }, [batch, place])

  const index = batch !== null && place?.batchId === batch.id ? place.index : -1
  const item = batch === null || index < 0 ? undefined : batch.items[index]
  const result = item === undefined || batch === null ? undefined : batch.results[item.itemId]
  /** A card just shown takes no Approve and no Skip for a moment (D15 «Lo que se vio es lo que se aprueba»). */
  const settle = useSettle(item?.itemId ?? '')

  /** Posts one decision on the item on screen; `moveOn` advances when it went through. */
  const send = useCallback(
    async (decision: Omit<Decision, 'itemId'>, moveOn: boolean): Promise<boolean> => {
      if (item === undefined) return false
      const running = lock.run(async (): Promise<boolean> => {
        setBusy(true)
        setNotice(undefined)
        try {
          const outcome = await decide({ ...decision, itemId: item.itemId })
          if (isRefusal(outcome)) {
            setNotice(outcome.text)
            return false
          }
          const key = decision.kind === 'approve' ? sendKeyOf(item) : null
          if (key !== null && outcome.state === 'sending') sends.track(key)
          if (moveOn) setAdvanceFrom(index)
          return true
        } finally {
          setBusy(false)
        }
      })
      return running ?? false
    },
    [item, lock, decide, sends, index],
  )

  const approve = useCallback(() => {
    if (item === undefined || !settle.ready() || !approveGate(item, result, new Date()).enabled) return
    void send({ kind: 'approve' }, true)
  }, [item, result, send, settle])

  // Skip asks for a reason in `skip-sheet.tsx` (R5a); until then, «not now».
  const skip = useCallback(() => {
    if (item === undefined || result !== undefined || !settle.ready()) return
    void send({ kind: 'skip', reason: 'not-now' }, true)
  }, [item, result, send, settle])

  const back = useCallback(() => {
    if (batch === null) return
    const from = index === -1 ? batch.items.length : index
    if (from > 0) setPlace({ batchId: batch.id, index: from - 1 })
  }, [batch, index])

  const forward = useCallback(() => {
    if (batch !== null) setPlace({ batchId: batch.id, index: nextOpen(batch, index) })
  }, [batch, index])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const modified = event.ctrlKey || event.metaKey || event.altKey
      const action = keyAction({ key: event.key, inField: isField(event.target), modified, repeat: event.repeat })
      if (action === null) return
      event.preventDefault()
      if (action === 'approve') approve()
      else if (action === 'skip') skip()
      else if (action === 'back') back()
      else box.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [approve, skip, back])

  const actions: ItemActions = {
    decide: (decision) => send(decision, decision.kind === 'instruct'),
    sendAnyway: () => void send({ kind: 'approve', addressOverride: true }, true),
    retryJob: async (applicationId, job) => {
      try {
        await api.post(`a/${encodeURIComponent(applicationId)}/retry`, { job })
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : 'the retry failed')
      }
    },
    settings: (anchor) => navigate(`settings#${anchor}`),
    skip,
  }

  if (answer === undefined) return <Shell error={error} onDismiss={clearError} sends={sends.sends} onRetry={sends.retry} />
  if (batch === null) {
    return (
      <Shell error={error} onDismiss={clearError} sends={sends.sends} onRetry={sends.retry}>
        <div class="j-empty">
          <p>No batch open.</p>
          <button type="button" class="btn primary" disabled={answer.ready === 0} onClick={() => void start()}>
            Start review ({answer.ready})
          </button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell batch={batch} index={index} error={error ?? notice} onDismiss={() => (clearError(), setNotice(undefined))} sends={sends.sends} onRetry={sends.retry}>
      {item === undefined ? (
        <End batch={batch} ready={answer.ready} onStart={() => void start()} />
      ) : (
        <>
          <ReviewItemView key={item.itemId} props={props} item={item} result={result} actions={actions} box={box} busy={busy} />
          <Buttons
            item={item}
            result={result}
            busy={busy || !settle.settled}
            canGoBack={index > 0}
            onBack={back}
            onSkip={skip}
            onApprove={approve}
            onForward={forward}
          />
        </>
      )}
    </Shell>
  )
}

interface ShellProps {
  readonly batch?: BatchView
  readonly index?: number
  readonly error: string | undefined
  readonly onDismiss: () => void
  readonly sends: readonly TrackedSend[]
  readonly onRetry: (key: SendKey) => Promise<void>
  readonly children?: ComponentChildren
}

function Shell({ batch, index, error, onDismiss, sends, onRetry, children }: ShellProps) {
  const header = batch === undefined || index === undefined ? undefined : headerOf(batch, index < 0 ? batch.items.length : index)
  return (
    <div class="j-screen">
      <header class="j-review-bar">
        <p class="j-crumb">
          Jobs › Review
          {header === undefined ? null : (
            <>
              {' · '}
              {header.test ? <span class="j-test">TEST</span> : null}
              {index !== undefined && index >= 0 ? header.label : `${batch?.items.length ?? 0} done`}
            </>
          )}
        </p>
        {header === undefined ? null : (
          <ol class="j-dots" aria-hidden="true">
            {header.dots.map((dot, at) => (
              <li key={at} class={`j-dot ${dot}`} />
            ))}
          </ol>
        )}
        {sends.length === 0 ? null : (
          <ul class="j-sends" role="status">
            {sends.map((send) => (
              <li key={`${send.key.applicationId}/${send.key.kind}`} class={`j-send ${send.line.tone}`}>
                {send.line.text}
                {send.line.retry ? (
                  <button type="button" class="btn sm quiet" onClick={() => void onRetry(send.key)}>
                    Retry
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </header>
      {error === undefined ? null : (
        <div class="notice err j-notice" role="alert">
          <p>{error}</p>
          <button type="button" class="btn sm quiet" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      )}
      <main class="j-review">{children ?? <p class="j-loading">Loading…</p>}</main>
    </div>
  )
}

interface ButtonsProps {
  readonly item: ReviewItem
  readonly result: BatchView['results'][string] | undefined
  readonly busy: boolean
  readonly canGoBack: boolean
  readonly onBack: () => void
  readonly onSkip: () => void
  readonly onApprove: () => void
  readonly onForward: () => void
}

function Buttons({ item, result, busy, canGoBack, onBack, onSkip, onApprove, onForward }: ButtonsProps) {
  const gate = approveGate(item, result, new Date())
  return (
    <div class="j-buttons">
      {gate.why === null ? null : <p class="j-why">{result === undefined ? `Approve is off: ${gate.why}` : `This one was ${gate.why}.`}</p>}
      <div class="j-button-row">
        <button type="button" class="btn" disabled={!canGoBack} onClick={onBack}>
          ← Back
        </button>
        {result === undefined ? (
          <>
            <button type="button" class="btn" disabled={busy} onClick={onSkip}>
              Skip
            </button>
            <button type="button" class="btn primary" disabled={busy || !gate.enabled} onClick={onApprove}>
              Approve &amp; next →
            </button>
          </>
        ) : (
          <button type="button" class="btn primary" onClick={onForward}>
            Next →
          </button>
        )}
      </div>
    </div>
  )
}

function End({ batch, ready, onStart }: { readonly batch: BatchView; readonly ready: number; readonly onStart: () => void }) {
  const summary = batchSummary(batch, ready)
  return (
    <section class="j-end">
      <h2>End of batch</h2>
      <ul class="j-summary">
        <li>{summary.approved} approved</li>
        <li>{summary.sent} sent</li>
        <li>{summary.skipped} skipped</li>
        <li>{summary.instructed} sent back to the AI</li>
      </ul>
      {summary.rewriting === 0 ? null : (
        <p class="j-still" role="status">
          {summary.rewriting} still rewriting…
        </p>
      )}
      {summary.nextBatch ? (
        <button type="button" class="btn primary" onClick={onStart}>
          Start next batch
        </button>
      ) : null}
    </section>
  )
}
