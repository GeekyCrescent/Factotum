/**
 * «Me voy» / «Volví»: the handoff sheet (spec 2026-10-07-dos-hosts, design D12; tasks K1). Four steps:
 *
 *   1. the PREVIEW, asynchronous (v4.3): `POST handoff/preview`, then `GET handoff/preview/:id` every
 *      second until it is ready or failed; a 404 (it expired, the daemon restarted) asks again;
 *   2. the confirmation;
 *   3. the progress: `GET handoff/:hid` every second;
 *   4. the report, all of it from `GET handoff/:hid`: what moved, what stayed and why, the services
 *      stopped, and what the other host said (`target*`). A project `pending-peer` offers «Keep them
 *      here», with the risk said first.
 *
 * `api` is the SOURCE's — the host whose sessions go, maybe another than the one serving the app — and
 * every route it calls is short, so it fits through the proxy (D13). What decides which buttons show
 * is `handoff.ts`, pure and tested; this paints it, checked by hand in K4.
 */

import { useCallback, useEffect, useState } from 'preact/hooks'
import type { Api } from './contract.ts'
import { messageOf } from './errors.ts'
import {
  actionsFor,
  failureText,
  isSettled,
  outcomeOf,
  pathsOf,
  plannedLine,
  reasonText,
  warningText,
  type PreviewView,
  type ReportView,
  type SheetState,
} from './handoff.ts'
import { Sheet } from './sheet.tsx'

const POLL_MS = 1_000

export function HandoffSheet({ api, from, to, onClose, onMoved }: {
  readonly api: Api
  /** The host whose sessions go, as the owner reads it. */
  readonly from: string
  /** The peer they go to: its name, as `peers` lists it on `from`. */
  readonly to: string
  readonly onClose: () => void
  /** The handoff ended: the lists of both hosts are read again. */
  readonly onMoved: () => void
}) {
  const [state, setState] = useState<SheetState>({ step: 'preview', preview: { state: 'running' } })
  const [hid, setHid] = useState<string | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<string | undefined>(undefined)
  const [keeping, setKeeping] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  usePreview(api, to, attempt, hid === undefined, setState, setError)
  useProgress(api, hid, setState, setError, onMoved)

  const confirm = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const started = await api.post<{ hid: string }>('handoff', { to })
      setHid(started.hid)
      setState({ step: 'moving', report: undefined })
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [api, to])

  const keep = useCallback(async (siteId: string) => {
    if (hid === undefined) return
    setBusy(true)
    try {
      await api.post(`handoff/${hid}/${siteId}/keep`)
      setKeeping(undefined)
      setState({ step: 'moving', report: await api.get<ReportView>(`handoff/${hid}`) })
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [api, hid])

  const title = `Move ${from}'s sessions to ${to}`
  if (keeping !== undefined) {
    return (
      <Sheet id="s-handoff-keep" title="Keep them here?" onClose={() => setKeeping(undefined)}>
        <p class="dim-2">
          {to} has not said whether it installed {keeping}. If it did, the two copies go on apart, and the next handoff between them will say
          their histories diverged.
        </p>
        {error === undefined ? null : <p class="s-error" role="alert">{error}</p>}
        <div class="s-dialog-acts">
          <button type="button" class="btn" onClick={() => setKeeping(undefined)}>Cancel</button>
          <button type="button" class="btn danger" disabled={busy} onClick={() => void keep(keeping)}>Keep them here</button>
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet id="s-handoff-title" title={title} onClose={onClose}>
      {state.step === 'preview' ? <PreviewBody preview={state.preview} to={to} /> : <ReportBody report={state.report} to={to} />}
      {error === undefined ? null : <p class="s-error" role="alert">{error}</p>}
      <div class="s-dialog-acts">
        {actionsFor(state).map((action) => {
          if (action === 'cancel') return <button key={action} type="button" class="btn" onClick={onClose}>Cancel</button>
          if (action === 'close') return <button key={action} type="button" class="btn" onClick={onClose}>Close</button>
          if (action === 'retry') return <button key={action} type="button" class="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          if (action === 'confirm') return <button key={action} type="button" class="btn primary" disabled={busy} onClick={() => void confirm()}>Move them</button>
          const siteId = action.slice('keep:'.length)
          return <button key={action} type="button" class="btn" onClick={() => setKeeping(siteId)}>Keep {siteId} here</button>
        })}
      </div>
    </Sheet>
  )
}

/** Step 1: ask for a preview, and ask after it every second. A 404 asks for a new one. */
function usePreview(api: Api, to: string, attempt: number, active: boolean, setState: (state: SheetState) => void, setError: (message: string | undefined) => void) {
  useEffect(() => {
    if (!active) return undefined
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setState({ step: 'preview', preview: { state: 'running' } })
    setError(undefined)
    const start = async () => {
      try {
        const { previewId } = await api.post<{ previewId: string }>('handoff/preview', { to })
        if (live) poll(previewId)
      } catch (cause: unknown) {
        if (live) setError(messageOf(cause))
      }
    }
    const poll = (previewId: string) => {
      timer = setTimeout(() => {
        api.get<PreviewView>(`handoff/preview/${previewId}`).then(
          (preview) => {
            if (!live) return
            setState({ step: 'preview', preview })
            if (preview.state === 'running') poll(previewId)
          },
          (cause: unknown) => {
            if (!live) return
            if ((cause as { status?: number }).status === 404) void start()
            else setError(messageOf(cause))
          },
        )
      }, POLL_MS)
    }
    void start()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [api, to, attempt, active])
}

/** Steps 3 and 4: the report, every second until it is settled. */
function useProgress(api: Api, hid: string | undefined, setState: (state: SheetState) => void, setError: (message: string | undefined) => void, onMoved: () => void) {
  useEffect(() => {
    if (hid === undefined) return undefined
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () => {
      api.get<ReportView>(`handoff/${hid}`).then(
        (report) => {
          if (!live) return
          setError(undefined)
          setState({ step: 'moving', report })
          if (isSettled(report)) onMoved()
          else timer = setTimeout(read, POLL_MS)
        },
        (cause: unknown) => {
          if (!live) return
          setError(messageOf(cause))
          timer = setTimeout(read, POLL_MS)
        },
      )
    }
    read()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [api, hid])
}

function PreviewBody({ preview, to }: { readonly preview: PreviewView; readonly to: string }) {
  if (preview.state === 'running') return <p class="dim-2" role="status">Looking at both hosts…</p>
  if (preview.state === 'failed') return <p class="dim-2" role="alert">{failureText(preview.reason, to)}</p>
  const { plan } = preview
  return (
    <div class="s-handoff">
      {plan.projects.length === 0 ? <p class="dim-2">Nothing here can move to {to} right now.</p> : null}
      {plan.projects.map((project) => (
        <section key={project.siteId} class="s-handoff-project">
          <h3>{project.siteId}</h3>
          <p class="dim-2">{plannedLine(project)}</p>
          {project.newUntracked.length === 0 ? null : (
            <>
              <p class="dim-2">New files that go to {to} with it:</p>
              <ul class="s-handoff-files">
                {project.newUntracked.map((file) => <li key={file}><code>{file}</code></li>)}
              </ul>
            </>
          )}
          {project.warnings.map((warning) => <p key={warning} class="notice">{warningText(warning, to, '')}</p>)}
        </section>
      ))}
      {plan.skipped.length === 0 ? null : (
        <section class="s-handoff-project">
          <h3>Stays here</h3>
          <ul>
            {plan.skipped.map((skip) => (
              <li key={`${skip.siteId}/${skip.sessionId ?? ''}/${skip.reason}`}>
                <strong>{skip.siteId}</strong>: {reasonText(skip.reason, to)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan.totals.archived + plan.totals.tooOld === 0 ? null : (
        <p class="dim-2">
          Not counted: {plan.totals.archived} archived, {plan.totals.tooOld} untouched for a day.
        </p>
      )}
    </div>
  )
}

function ReportBody({ report, to }: { readonly report: ReportView | undefined; readonly to: string }) {
  if (report === undefined || report.state === 'planning') return <p class="dim-2" role="status">Getting ready…</p>
  if (report.state === 'failed') return <p class="dim-2" role="alert">{failureText(report.failure ?? 'internal', to)}</p>
  return (
    <div class="s-handoff" role="status">
      {report.projects.map((project) => {
        const outcome = outcomeOf(project, to, report.hid)
        const paths = pathsOf(project)
        return (
          <section key={project.siteId} class={`s-handoff-project s-handoff-${outcome.tone}`}>
            <h3>{project.siteId}</h3>
            <p>{outcome.text}</p>
            {paths.shown.length === 0 ? null : (
              <ul class="s-handoff-files">
                {paths.shown.map((path) => <li key={path}><code>{path}</code></li>)}
                {paths.more > 0 ? <li>and {paths.more} more</li> : null}
              </ul>
            )}
            {outcome.notes.map((note) => <p key={note} class="dim-2">{note}</p>)}
          </section>
        )
      })}
      {(report.skipped ?? []).map((skip) => (
        <p key={`${skip.siteId}/${skip.sessionId ?? ''}`} class="dim-2">
          <strong>{skip.siteId}</strong> stays here: {reasonText(skip.reason, to)}
        </p>
      ))}
    </div>
  )
}
