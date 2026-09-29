/**
 * One session, the whole screen: its bar, the strip for another session waiting, the log, and the
 * dock with the ask and the reply (spec 2026-09-18, design D5).
 *
 * ITS OWN SUMMARY (spec 2026-09-29, D9): `GET sessions/:id` when it opens and whenever its state
 * changes, so any conversation opens with its title, its state and its project's colour — not only
 * the ones on the first page of a list (criterion 36). A conversation of a project whose folder is
 * missing is not read: the screen says so and shows no log (criterion 25).
 *
 * THE LOG IS THE CURSOR. `GET sessions/:id/events?fromSeq=` every POLL_MS while it runs; a
 * reconnect is the same request with a different number, so nothing is buffered and nothing is
 * de-duplicated. Polling stops the moment it is over, and a reply starts it again.
 *
 * NO CONSOLE (criterion 37): the ask token passes through here.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { EngineSetupView, EventPage, ProjectRef, SessionEvent, SessionState, SessionSummary } from '../types.ts'
import { AskPanel, useAsk } from './ask-panel.tsx'
import { ReplyComposer } from './composer.tsx'
import type { Api, ViewProps } from './contract.ts'
import { messageOf } from './errors.ts'
import { Details } from './details.tsx'
import { stateLabel } from './format.ts'
import { Icon } from './icon.tsx'
import { Log } from './rows.tsx'
import { MenuButton, Strip, TopBar } from './bars.tsx'
import { ConversationMenu } from './conversation-menu.tsx'
import { nameOf } from './history.ts'
import { askFor, sessionOf, type AskRef } from './relevance.ts'
import { toneClass } from './tone.ts'

/** How often the cursor asks again while a session is running. */
const POLL_MS = 1_000
const ASK = 'ask'

type Found =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly summary: SessionSummary; readonly project: ProjectRef | undefined }
  | { readonly kind: 'missing'; readonly siteId: string }
  | { readonly kind: 'gone' }
  | { readonly kind: 'error'; readonly message: string }

/** The conversation's summary, read again every time `generation` moves. */
function useSummary(api: Api, id: string, generation: number): Found {
  const [found, setFound] = useState<Found>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    api
      .get<{ summary: SessionSummary; project: ProjectRef | undefined }>(`sessions/${id}`)
      .then((got) => {
        if (live) setFound({ kind: 'ok', summary: got.summary, project: got.project })
      })
      .catch((cause: unknown) => {
        if (!live) return
        const error = cause as { status?: number; body?: { missing?: { siteId?: string } } }
        if (error.status === 409 && typeof error.body?.missing?.siteId === 'string') setFound({ kind: 'missing', siteId: error.body.missing.siteId })
        else if (error.status === 404 || error.status === 400) setFound({ kind: 'gone' })
        else setFound((current) => (current.kind === 'ok' ? current : { kind: 'error', message: messageOf(cause) }))
      })
    return () => {
      live = false
    }
  }, [api, id, generation])
  return found
}

export function Session({
  view,
  id,
  setup,
  onChanged,
}: {
  readonly view: ViewProps
  readonly id: string
  readonly setup: EngineSetupView
  readonly onChanged: () => void
}) {
  const [generation, setGeneration] = useState(0)
  const found = useSummary(view.api, id, generation)
  const changed = useCallback(() => {
    setGeneration((n) => n + 1)
    onChanged()
  }, [onChanged])

  if (found.kind === 'missing' || found.kind === 'gone') {
    return (
      <div class="s-screen">
        <TopBar title={found.kind === 'missing' ? found.siteId : 'Conversation'} pendingTotal={view.pendingTotal} onMenu={view.openDrawer} />
        <div class="center-state">
          <Icon name="warning" size={32} />
          <h2>{found.kind === 'missing' ? "This project's folder is missing" : 'This conversation is not here'}</h2>
          <p>
            {found.kind === 'missing'
              ? 'Its conversations are not read while the folder is gone. Put the folder back and it reads again.'
              : 'It was deleted, or it never existed.'}
          </p>
          <button type="button" class="btn" onClick={() => view.navigate('new')}>
            New session
          </button>
        </div>
      </div>
    )
  }
  return (
    <Live
      view={view}
      id={id}
      setup={setup}
      summary={found.kind === 'ok' ? found.summary : undefined}
      project={found.kind === 'ok' ? found.project : undefined}
      onChanged={changed}
    />
  )
}

function Live({
  view,
  id,
  setup,
  summary,
  project,
  onChanged,
}: {
  readonly view: ViewProps
  readonly id: string
  readonly setup: EngineSetupView
  readonly summary: SessionSummary | undefined
  readonly project: ProjectRef | undefined
  readonly onChanged: () => void
}) {
  const { api } = view
  const { events, state, error, restart } = useEvents(api, id, onChanged)
  const [cancelError, setCancelError] = useState<string | undefined>(undefined)
  const [showDetails, setShowDetails] = useState(false)
  const running = state === 'running'
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
    // The project's colour, for everything in the screen that says whose it is (its dot, the bubbles).
    <div class={summary === undefined ? 's-screen' : `s-screen ${toneClass(summary.siteId, project?.color)}`}>
      <header class="topbar">
        <MenuButton pendingTotal={view.pendingTotal} onMenu={view.openDrawer} />
        <div class="title s-title">
          <h1>{project?.name ?? summary?.siteId ?? id.slice(0, 8)}</h1>
          <span class={`s-badge s-state-${state}`}>{stateLabel(state)}</span>
          {summary === undefined ? null : <p class="s-subtitle">{nameOf(summary)}</p>}
        </div>
        <button
          type="button"
          class="icon-btn"
          aria-label="Details"
          aria-expanded={showDetails}
          onClick={() => setShowDetails(!showDetails)}
        >
          <Icon name="info" />
        </button>
        {running ? (
          <button type="button" class="btn" onClick={() => void cancel()}>
            Cancel
          </button>
        ) : (
          <button type="button" class="icon-btn" aria-label="New session" onClick={() => view.navigate('new')}>
            <Icon name="note-pencil" />
          </button>
        )}
        {summary === undefined ? null : (
          <ConversationMenu api={api} summary={summary} running={running} onChanged={onChanged} onDeleted={() => {
            onChanged()
            view.navigate('new')
          }} />
        )}
      </header>
      {showDetails ? <Details id={id} summary={summary} setup={setup} now={Date.now()} /> : null}
      {other === undefined ? null : <Strip pending={other} onOpen={(to) => view.navigate(to)} />}
      <div class="s-body">
        <Log events={events} running={running} asking={ask !== undefined} />
        {/* Where the next line will appear, so the eye is already there. Not while it waits on the owner. */}
        {running && ask === undefined ? (
          <p class="s-working" role="status">
            <Icon name="circle-notch" size={16} />
            {events.length === 0 ? 'Starting the agent…' : 'Working…'}
          </p>
        ) : null}
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

