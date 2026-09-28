/**
 * One session, the whole screen: its bar, the strip for another session waiting, the log, and the
 * dock with the ask and the reply (spec 2026-09-18, design D5).
 *
 * THE LOG IS THE CURSOR. `GET sessions/:id/events?fromSeq=` every POLL_MS while it runs; a
 * reconnect is the same request with a different number, so nothing is buffered and nothing is
 * de-duplicated. Polling stops the moment it is over, and a reply starts it again.
 *
 * NO CONSOLE (criterion 37): the ask token passes through here.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { EngineSetupView, EventPage, SessionEvent, SessionState, SessionSummary } from '../types.ts'
import { AskPanel, useAsk } from './ask-panel.tsx'
import { ReplyComposer } from './composer.tsx'
import type { Api, ViewProps } from './contract.ts'
import { messageOf } from './errors.ts'
import { duration, stateLabel } from './format.ts'
import { Icon } from './icon.tsx'
import { Log } from './rows.tsx'
import { MenuButton, Strip } from './bars.tsx'
import { askFor, sessionOf, type AskRef } from './relevance.ts'

/** How often the cursor asks again while a session is running. */
const POLL_MS = 1_000
const ASK = 'ask'

export function Session({
  view,
  id,
  setup,
  summary,
  onChanged,
}: {
  readonly view: ViewProps
  readonly id: string
  readonly setup: EngineSetupView
  readonly summary: SessionSummary | undefined
  readonly onChanged: () => void
}) {
  const { api } = view
  const { events, state, error, restart } = useEvents(api, id, onChanged)
  const [cancelError, setCancelError] = useState<string | undefined>(undefined)
  const running = state === 'running'
  const entry = setup.catalog.find((e) => e.id === summary?.entryId)
  const other = view.pending.find((p) => sessionOf(p) !== undefined && sessionOf(p) !== id)
  // Held after its pending is resolved: the answer stays where the buttons were (design D6).
  const held = useRef<AskRef | undefined>(undefined)
  const found = askFor(id, view.pending, view.search) ?? held.current
  held.current = found
  // A token from the URL carries no site: the session's summary does.
  const withSite = found === undefined || found.siteId !== undefined || summary === undefined ? found : { ...found, siteId: summary.siteId }
  const ask = running ? withSite : undefined
  const end = useScrollToEnd(events.length)

  const cancel = async () => {
    setCancelError(undefined)
    try {
      await api.post(`sessions/${id}/cancel`)
      restart()
    } catch (cause: unknown) {
      setCancelError(messageOf(cause))
    }
  }

  return (
    <div class="s-screen">
      <header class="topbar">
        <MenuButton pendingTotal={view.pendingTotal} onMenu={view.openDrawer} />
        <div class="title">
          <h1>{summary?.siteId ?? id.slice(0, 8)}</h1>
          <p>
            <span class={`s-state-${state}`}>{stateLabel(state)}</span>
            {entry === undefined ? '' : ` · ${entry.label}`}
            {summary === undefined ? '' : ` · ${duration(summary.startedAt, summary.endedAt, Date.now())}`}
          </p>
        </div>
        {running ? (
          <button type="button" class="btn" onClick={() => void cancel()}>
            Cancel
          </button>
        ) : (
          <button type="button" class="icon-btn" aria-label="New session" onClick={() => view.navigate('new')}>
            <Icon name="note-pencil" />
          </button>
        )}
      </header>
      {other === undefined ? null : <Strip pending={other} onOpen={(to) => view.navigate(to)} />}
      <div class="s-body">
        <Log events={events} running={running} asking={ask !== undefined} />
        {running && events.length === 0 ? <p class="s-quiet dim-3">Starting the agent.</p> : null}
        <div ref={end} />
      </div>
      <div class="s-dock">
        {error === undefined && cancelError === undefined ? null : (
          <div class="notice err" role="alert">
            <div class="head">
              <Icon name="warning" size={16} />
              {cancelError ?? error}
            </div>
          </div>
        )}
        {ask === undefined ? null : <AskArea key={ask.tag} view={view} ask={ask} setup={setup} />}
        {running ? null : (
          <ReplyComposer
            api={api}
            sessionId={id}
            siteId={summary?.siteId}
            onSent={restart}
            goTo={(to) => view.navigate(to)}
          />
        )}
      </div>
    </div>
  )
}

/** The ask this session waits on: a notice in the dock, and the sheet, which opens once by itself. */
function AskArea({ view, ask, setup }: { readonly view: ViewProps; readonly ask: AskRef; readonly setup: EngineSetupView }) {
  const { api, overlay, setOverlay, resolvePending } = view
  const { state, answer } = useAsk(api, ask, resolvePending)
  const opened = useRef(false)
  const close = useCallback(() => setOverlay(undefined), [setOverlay])
  const sitePath = setup.sites.find((site) => site.id === ask.siteId)?.path

  useEffect(() => {
    if (opened.current || state.kind === 'over') return
    opened.current = true
    setOverlay(ASK)
  }, [state.kind, setOverlay])

  return (
    <>
      {overlay === ASK ? null : (
        <div class={state.kind === 'over' ? 'notice' : 'notice ask'} role="status">
          <div class="head">
            <Icon name="hand" size={16} />
            {state.kind === 'over' ? state.message : 'Waiting for you'}
          </div>
          {state.kind === 'over' ? null : (
            <div class="acts">
              <button type="button" class="btn" onClick={() => setOverlay(ASK)}>
                Review
              </button>
            </div>
          )}
        </div>
      )}
      {overlay === ASK ? <AskPanel ask={ask} state={state} answer={answer} sitePath={sitePath} onClose={close} /> : null}
    </>
  )
}

/** Keyed by session in index.tsx: a new id is a new component, so the cursor starts at 0. */
function useEvents(api: Api, id: string, onChanged: () => void) {
  const [events, setEvents] = useState<readonly SessionEvent[]>([])
  const [state, setState] = useState<SessionState>('running')
  const [error, setError] = useState<string | undefined>(undefined)
  /** Bumped by a reply or a cancel, which is what restarts the polling a finished session stopped. */
  const [generation, setGeneration] = useState(0)
  const cursor = useRef(0)
  const last = useRef<SessionState | undefined>(undefined)
  const changed = useRef(onChanged)
  changed.current = onChanged

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const page = await api.get<EventPage>(`sessions/${id}/events?fromSeq=${cursor.current}`)
        if (!live) return
        if (page.events.length > 0) {
          cursor.current = page.nextSeq
          setEvents((previous) => [...previous, ...page.events])
        }
        setState(page.state)
        setError(undefined)
        if (last.current !== undefined && last.current !== page.state) changed.current()
        last.current = page.state
        if (page.state === 'running') timer = setTimeout(() => void poll(), POLL_MS)
      } catch (cause: unknown) {
        if (live) setError(messageOf(cause))
      }
    }
    void poll()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [api, id, generation])

  const restart = useCallback(() => {
    setState('running')
    setGeneration((n) => n + 1)
    changed.current()
  }, [])

  return { events, state, error, restart }
}

/** Keeps the end of the log in view while new rows arrive, unless the owner scrolled up to read. */
function useScrollToEnd(count: number) {
  const end = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  useEffect(() => {
    const target = end.current
    if (target === null || count === 0) return
    const nearEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - window.innerHeight / 2
    if (first.current || nearEnd) target.scrollIntoView({ block: 'end' })
    first.current = false
  }, [count])
  return end
}

