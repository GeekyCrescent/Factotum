/**
 * The approval sheet for a FOLDER REQUEST: a new project or shared folder waiting on the owner
 * (spec 2026-09-29, D3, D10). The twin of `ask-panel.tsx`.
 *
 * THE TOKEN AUTHORISES, as for an ask: it comes from the pending the worker kept, or from the
 * `?grant=` the notification opened the page with, and it reads the request (`GET grants/:token`,
 * which has the full path the push never carries) and answers it. On the daemon's own machine the
 * device keeps no token, and the sheet says to approve from the phone.
 *
 * NO CONSOLE, anywhere here (criterion 41): the token is in this file's hands.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { Color } from '../types.ts'
import type { Api } from './contract.ts'
import { messageOf } from './errors.ts'
import { clock } from './format.ts'
import { createGuard } from './guard.ts'
import { Icon } from './icon.tsx'
import { toneClass } from './tone.ts'

export type GrantInfo =
  | { readonly kind: 'project'; readonly path: string; readonly id: string; readonly name?: string; readonly color?: Color; readonly expiresAt: string }
  | { readonly kind: 'shared'; readonly path: string; readonly expiresAt: string }

/** What the sheet is about: a token if this device has one, the pending's tag, the folder's name. */
export interface GrantTarget {
  readonly token: string | undefined
  readonly tag: string | undefined
  readonly name: string | undefined
}

export type GrantState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'no-token' }
  | { readonly kind: 'waiting'; readonly info: GrantInfo | undefined }
  | { readonly kind: 'over'; readonly message: string }

const statusOf = (cause: unknown) => (cause as { status?: number } | undefined)?.status

interface Answered {
  readonly first: boolean
  readonly outcome: 'approved' | 'denied' | 'rejected'
  readonly reason?: string
}

function said(result: Answered, kind: GrantInfo['kind'] | undefined): string {
  const done =
    result.outcome === 'approved'
      ? kind === 'shared'
        ? 'Shared. Every project can write there now.'
        : 'Added. It is in your projects now.'
      : result.outcome === 'denied'
        ? 'Denied. Nothing was added.'
        : `Could not add it: ${result.reason ?? 'no reason given'}`
  return result.first ? done : `Already answered. ${done}`
}

/** Reads the request once, and answers it. Whatever ends it also ends its pending. */
export function useGrant(api: Api, target: GrantTarget, onOver: (tag: string | undefined) => void) {
  const [state, setState] = useState<GrantState>(target.token === undefined ? { kind: 'no-token' } : { kind: 'loading' })
  const over = useRef(onOver)
  over.current = onOver

  useEffect(() => {
    const token = target.token
    if (token === undefined) {
      setState({ kind: 'no-token' })
      return undefined
    }
    let live = true
    setState({ kind: 'loading' })
    api
      .get<GrantInfo>(`grants/${token}`)
      .then((info) => {
        if (live) setState({ kind: 'waiting', info })
      })
      .catch((cause: unknown) => {
        if (!live) return
        const status = statusOf(cause)
        if (status === 409 || status === 404) {
          setState({ kind: 'over', message: status === 409 ? 'Already answered or expired.' : 'That request is no longer waiting.' })
          over.current(target.tag)
          return
        }
        setState({ kind: 'waiting', info: undefined })
      })
    return () => {
      live = false
    }
  }, [api, target.token, target.tag])

  const answer = async (decision: 'allow' | 'deny') => {
    if (target.token === undefined) return
    const kind = state.kind === 'waiting' ? state.info?.kind : undefined
    let message: string
    try {
      message = said(await api.post<Answered>(`grants/${target.token}/answer`, { decision }), kind)
    } catch (cause: unknown) {
      const status = statusOf(cause)
      if (status !== 409 && status !== 404) throw cause
      message = status === 409 ? 'Too late: it expired, and nothing was added.' : 'That request is no longer waiting.'
    }
    setState({ kind: 'over', message })
    over.current(target.tag)
  }

  return { state, answer }
}

export function GrantPanel({
  target,
  state,
  answer,
  onClose,
}: {
  readonly target: GrantTarget
  readonly state: GrantState
  readonly answer: (decision: 'allow' | 'deny') => Promise<void>
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
  const what = info?.kind === 'shared' ? 'Share a folder' : 'Add a project'
  const name = info?.kind === 'project' ? (info.name ?? info.id) : target.name

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
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="s-grant-title">
        <div class="grab" />
        <div class="s-kicker">
          <Icon name="hand" size={16} />
          Waiting for you
          {info === undefined ? null : <span class="s-deadline num">expires {clock(info.expiresAt)}</span>}
        </div>
        <h2 id="s-grant-title" ref={title} tabIndex={-1}>
          {name === undefined ? what : `${what}: ${name}`}
        </h2>
        {info === undefined ? null : (
          <dl class="s-facts">
            <dt>Folder</dt>
            <dd class="mono">{info.path}</dd>
            {info.kind === 'project' ? (
              <>
                <dt>Id</dt>
                <dd class={`mono s-id ${toneClass(info.id, info.color)}`}>{info.id}</dd>
              </>
            ) : null}
          </dl>
        )}
        {info === undefined ? null : (
          <p class="dim-2">
            {info.kind === 'project'
              ? 'Agents launched in this project may write anywhere inside this folder.'
              : 'Agents in every project may write anywhere inside this folder, and nothing locks it.'}
          </p>
        )}
        {state.kind === 'loading' ? <p class="dim-3">Reading the request.</p> : null}
        {state.kind === 'no-token' ? (
          <p class="dim-2">Approve it on your phone: this browser runs on the daemon's machine, so it keeps no approval tokens.</p>
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
              {info?.kind === 'shared' ? 'Share' : 'Add'}
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
