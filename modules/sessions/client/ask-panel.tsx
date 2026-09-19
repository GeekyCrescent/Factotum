/**
 * The approval panel: a sheet with everything needed to decide, and the two buttons (spec
 * 2026-09-18, design D6; criteria 20, 21, 24).
 *
 * TWO SOURCES. What arrives at once (tool, file, session, site, token) comes from the pending the
 * worker kept or from the query the page loaded with. The full path, the preview and the
 * authoritative deadline come from `GET asks/:askId`, which needs the token: whoever can read could
 * already answer.
 *
 * NO CONSOLE, anywhere here (criterion 37): the token is in this file's hands.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { AskPreview } from '../types.ts'
import type { Api } from './contract.ts'
import { messageOf } from './errors.ts'
import { clock, fileName, previewText } from './format.ts'
import { createGuard } from './guard.ts'
import { Icon } from './icon.tsx'
import type { AskRef } from './relevance.ts'

interface AskInfo {
  readonly sessionId: string
  readonly toolName: string
  readonly target: string
  readonly preview: AskPreview | null
  readonly deadlineAt: string
}

export type AskState =
  | { readonly kind: 'loading' }
  /** On the daemon's machine the device keeps no token: the notification is the way to answer. */
  | { readonly kind: 'no-token' }
  | { readonly kind: 'waiting'; readonly info: AskInfo | undefined }
  | { readonly kind: 'over'; readonly message: string }

export interface Ask {
  readonly state: AskState
  readonly answer: (decision: 'allow' | 'deny') => Promise<void>
}

const statusOf = (cause: unknown) => (cause as { status?: number } | undefined)?.status

/** Reads the ask once, and answers it. Whatever ends it also ends its pending. */
export function useAsk(api: Api, ask: AskRef, resolvePending: (tag: string) => void): Ask {
  const [state, setState] = useState<AskState>(ask.askId === undefined ? { kind: 'no-token' } : { kind: 'loading' })
  // Read through a ref: a new function from the shell must not read the ask again.
  const resolve = useRef(resolvePending)
  resolve.current = resolvePending

  useEffect(() => {
    const askId = ask.askId
    if (askId === undefined) {
      setState({ kind: 'no-token' })
      return undefined
    }
    let live = true
    setState({ kind: 'loading' })
    api
      .get<AskInfo>(`asks/${askId}`)
      .then((info) => {
        if (live) setState({ kind: 'waiting', info })
      })
      .catch((cause: unknown) => {
        if (!live) return
        const status = statusOf(cause)
        if (status === 409 || status === 404) {
          setState({ kind: 'over', message: status === 409 ? 'Already answered or expired.' : 'That request is no longer waiting.' })
          resolve.current(ask.tag)
          return
        }
        // Could not read it, which does not mean it is over: the buttons still work with the token.
        setState({ kind: 'waiting', info: undefined })
      })
    return () => {
      live = false
    }
  }, [api, ask.askId, ask.tag])

  const answer = async (decision: 'allow' | 'deny') => {
    if (ask.askId === undefined) return
    let message: string
    try {
      const result = await api.post<{ first?: boolean }>(`asks/${ask.askId}/answer`, { decision })
      message = result.first === false ? 'Already answered.' : decision === 'allow' ? 'Allowed. The agent carries on.' : 'Denied.'
    } catch (cause: unknown) {
      const status = statusOf(cause)
      // Anything else (the network, the daemon down) does not end the ask: the panel says so and
      // the buttons stay.
      if (status !== 409 && status !== 404) throw cause
      message = status === 409 ? 'Too late: it was already denied.' : 'That request is no longer waiting.'
    }
    setState({ kind: 'over', message })
    resolve.current(ask.tag)
  }

  return { state, answer }
}

export function AskPanel({
  ask,
  state,
  answer,
  sitePath,
  onClose,
}: {
  readonly ask: AskRef
  readonly state: AskState
  readonly answer: Ask['answer']
  readonly sitePath: string | undefined
  readonly onClose: () => void
}) {
  const title = useRef<HTMLHeadingElement>(null)
  const guard = useRef(createGuard(() => performance.now()))
  const pressedAt = useRef<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    title.current?.focus()
    const frame = requestAnimationFrame(() => guard.current.shown())
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      before?.focus()
    }
  }, [onClose])

  const info = state.kind === 'waiting' ? state.info : undefined
  const tool = info?.toolName ?? ask.toolName ?? 'A tool'
  const file = info === undefined ? ask.file : fileName(info.target)
  const heading = [tool, file, ask.siteId === undefined ? undefined : `outside ${ask.siteId}`].filter(Boolean).join(' ')

  const decide = (decision: 'allow' | 'deny') => async () => {
    const at = pressedAt.current
    pressedAt.current = undefined
    if (!guard.current.accepts(at)) return
    setBusy(true)
    setFailure(undefined)
    try {
      await answer(decision)
    } catch (cause: unknown) {
      setFailure(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }
  const press = () => {
    pressedAt.current = performance.now()
  }

  return (
    <>
      <div class="scrim" onClick={onClose} />
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="s-ask-title">
        <div class="grab" />
        <div class="s-kicker">
          <Icon name="hand" size={16} />
          Waiting for you
          {info === undefined ? null : <span class="s-deadline num">auto-deny {clock(info.deadlineAt)}</span>}
        </div>
        <h2 id="s-ask-title" ref={title} tabIndex={-1}>
          {heading}
        </h2>
        <dl class="s-facts">
          {info === undefined ? null : (
            <>
              <dt>Path</dt>
              <dd class="mono">{info.target}</dd>
            </>
          )}
          {ask.siteId === undefined && sitePath === undefined ? null : (
            <>
              <dt>Site</dt>
              <dd class="mono">{sitePath ?? ask.siteId}</dd>
            </>
          )}
        </dl>
        {info?.preview === null || info === undefined ? null : <Preview preview={info.preview} />}
        {state.kind === 'loading' ? <p class="dim-3">Reading the request.</p> : null}
        {state.kind === 'no-token' ? (
          <p class="dim-2">
            This browser runs on the daemon's machine, so it keeps no approval tokens. Answer from the notification.
          </p>
        ) : null}
        {state.kind === 'over' ? (
          <p class="s-outcome" role="status">
            {state.message}
          </p>
        ) : null}
        {state.kind === 'waiting' ? (
          <div class="s-choice">
            <button type="button" class="btn decide" disabled={busy} onPointerDown={press} onClick={decide('deny')}>
              Deny
            </button>
            <button type="button" class="btn decide primary" disabled={busy} onPointerDown={press} onClick={decide('allow')}>
              Allow once
            </button>
          </div>
        ) : null}
        {failure === undefined ? null : (
          <p class="s-error" role="alert">
            {failure}
          </p>
        )}
      </div>
    </>
  )
}

function Preview({ preview }: { readonly preview: AskPreview }) {
  const text = previewText(preview)
  return (
    <div class="s-preview-wrap">
      {text.edits === undefined ? null : <p class="s-note">{text.edits}</p>}
      <pre class="s-preview mono">
        {text.head}
        {text.cut === undefined ? null : <span class="s-gap">…</span>}
        {text.tail}
      </pre>
      {text.cut === undefined ? null : <p class="s-note num">{text.cut}</p>}
    </div>
  )
}
