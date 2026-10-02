/**
 * One background service, in a sheet (spec 2026-10-02-servicios-en-segundo-plano, D15): its state, the last
 * lines of its output, Refresh, and Stop while it runs (criterion 36). An ended service opens the same way,
 * without Stop (criterion 39).
 *
 * STOP ASKS FIRST, in the sheet itself — a stray tap would kill the long copy the owner left running
 * (requirements §7, open question 2). The output is never streamed: read on open and on Refresh
 * (ADR-0012, *never a stream*).
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { ServiceOutput, ServiceView } from '../types.ts'
import type { Api } from './contract.ts'
import { messageOf } from './errors.ts'
import { Icon } from './icon.tsx'
import { viewOutcome } from './services.ts'
import { Sheet } from './sheet.tsx'

/** What the sheet asks for: the route's default, said here so the request is explicit. */
const LINES = 50

type Load = { readonly kind: 'loading' } | { readonly kind: 'ok'; readonly output: ServiceOutput } | { readonly kind: 'error'; readonly message: string }

export function ServicesSheet({
  api,
  sessionId,
  serviceId,
  onClose,
  onStopped,
}: {
  readonly api: Api
  readonly sessionId: string
  readonly serviceId: string
  readonly onClose: () => void
  /** The log has a new `ended` to show: the screen reads it again without a reload. */
  readonly onStopped: () => void
}) {
  const base = `sessions/${sessionId}/services/${encodeURIComponent(serviceId)}`
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const out = useRef<HTMLPreElement>(null)

  const read = useCallback(() => {
    api
      .get<ServiceOutput>(`${base}/output?lines=${LINES}`)
      .then((output) => setLoad({ kind: 'ok', output }))
      .catch((cause: unknown) => setLoad({ kind: 'error', message: messageOf(cause) }))
  }, [api, base])

  useEffect(() => read(), [read])
  // The newest lines are the ones that matter: opened, or refreshed, at the bottom.
  useEffect(() => {
    if (out.current !== null) out.current.scrollTop = out.current.scrollHeight
  }, [load])

  const stop = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const view = await api.post<ServiceView>(`${base}/stop`)
      setLoad((current) => (current.kind === 'ok' ? { kind: 'ok', output: { ...current.output, view } } : current))
      setConfirming(false)
      onStopped()
      read()
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const view = load.kind === 'ok' ? load.output.view : undefined
  const status = view === undefined ? undefined : viewOutcome(view, Date.now())
  return (
    <Sheet id="s-service-title" title={view?.description ?? view?.command ?? serviceId} onClose={onClose}>
      {load.kind === 'error' ? (
        <p class="s-error" role="alert">
          {load.message}
        </p>
      ) : null}
      {view === undefined || status === undefined ? (
        load.kind === 'loading' ? <p class="dim-2">Reading the output…</p> : null
      ) : (
        <>
          <p class={`s-svc-state s-sub-${status.tone}`}>
            <Icon name={status.tone === 'running' ? 'circle-notch' : status.tone === 'failed' ? 'x-circle' : 'terminal'} size={14} />
            <span class="s-sub-end">{status.text}</span>
          </p>
          <p class="s-svc-meta mono">{view.command}</p>
          <p class="s-svc-meta dim-3">
            {serviceId} · pid {view.pid} · {view.cwd}
          </p>
          <pre ref={out} class="s-svc-out mono" aria-label="Last lines of output">
            {load.kind === 'ok' && load.output.lines.length > 0 ? load.output.lines.join('\n') : 'No output yet.'}
          </pre>
        </>
      )}
      {error === undefined ? null : (
        <p class="s-error" role="alert">
          {error}
        </p>
      )}
      {confirming ? (
        <div class="s-dialog-acts">
          <p class="s-svc-ask">Stop this service? Its whole process group is stopped.</p>
          <button type="button" class="btn" onClick={() => setConfirming(false)}>
            Keep it
          </button>
          <button type="button" class="btn danger" disabled={busy} onClick={() => void stop()}>
            Stop
          </button>
        </div>
      ) : (
        <div class="s-dialog-acts">
          <button type="button" class="btn" onClick={read}>
            Refresh
          </button>
          {view?.state === 'running' ? (
            <button type="button" class="btn danger" onClick={() => setConfirming(true)}>
              Stop
            </button>
          ) : null}
        </div>
      )}
    </Sheet>
  )
}
