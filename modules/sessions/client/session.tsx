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

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { EngineSetupView, EventPage, ProjectRef, SessionEvent, SessionState, SessionSummary } from '../types.ts'
import { activity } from './activity.ts'
import { AskPanel, useAsk } from './ask-panel.tsx'
import { ReplyComposer } from './composer.tsx'
import type { Api, ViewProps } from './contract.ts'
import { messageOf } from './errors.ts'
import { Details } from './details.tsx'
import { fold, type SubagentRow } from './fold.ts'
import { duration, stateLabel } from './format.ts'
import { Icon } from './icon.tsx'
import { Log } from './rows.tsx'
import { openSubagents } from './subagents.ts'
import { MenuButton, Strip, TopBar } from './bars.tsx'
import { ConversationMenu } from './conversation-menu.tsx'
import { awaitingTitle, nameOf, TITLE_POLL_MS } from './history.ts'
import { mayOpenItself } from './overlays.ts'
import { askedBy, emptyDraft, sheetState, type Draft } from './questions.ts'
import { QuestionsSheet, useBatch } from './questions-sheet.tsx'
import { askFor, questionsFor, sessionOf, withLogBatches, type AskRef, type QuestionsRef } from './relevance.ts'
import { toneClass } from './tone.ts'

/** The glyph beside the state at the top right. */
const STATE_GLYPH: Readonly<Record<SessionState, 'check-circle' | 'x-circle' | 'minus-circle' | 'circle-notch'>> = {
  running: 'circle-notch',
  finished: 'check-circle',
  failed: 'x-circle',
  cancelled: 'minus-circle',
}

/** How often the cursor asks again while a session is running. */
const POLL_MS = 1_000
const ASK = 'ask'
/** One overlay for every batch: which batch it shows is the screen's (`sheetTag`). */
const QUESTIONS = 'questions'

type Found =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly summary: SessionSummary; readonly project: ProjectRef | undefined }
  | { readonly kind: 'missing'; readonly siteId: string }
  | { readonly kind: 'gone' }
  | { readonly kind: 'error'; readonly message: string }

/**
 * The conversation's summary, read again every time `generation` moves — AND, while a new one still
 * waits for its title, every TITLE_POLL_MS (spec 2026-09-30, D11). `generation` only moves when the
 * state does, so without this the titler's title would reach the header only when the turn ended.
 */
function useSummary(api: Api, id: string, generation: number): Found {
  const [found, setFound] = useState<Found>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = (): void => {
      api
        .get<{ summary: SessionSummary; project: ProjectRef | undefined }>(`sessions/${id}`)
        .then((got) => {
          if (!live) return
          setFound({ kind: 'ok', summary: got.summary, project: got.project })
          // Bounded: past TITLE_WAIT_MS it stops, so an old conversation never polls at all.
          if (awaitingTitle(got.summary, Date.now())) timer = setTimeout(read, TITLE_POLL_MS)
        })
        .catch((cause: unknown) => {
          if (!live) return
          const error = cause as { status?: number; body?: { missing?: { siteId?: string } } }
          if (error.status === 409 && typeof error.body?.missing?.siteId === 'string') setFound({ kind: 'missing', siteId: error.body.missing.siteId })
          else if (error.status === 404 || error.status === 400) setFound({ kind: 'gone' })
          else setFound((current) => (current.kind === 'ok' ? current : { kind: 'error', message: messageOf(cause) }))
        })
    }
    read()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
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
  // Folded once, here: the log paints these rows and the line under it reads the open subagents from
  // the same ones, so the two cannot disagree (spec 2026-10-01-subagentes-visibles, D7).
  const rows = useMemo(() => activity(fold(events)), [events])
  const open = running ? openSubagents(rows) : []
  // Questions (spec 2026-10-01-preguntas-con-opciones, D10, D12): the batches this session waits on, and
  // which one the sheet shows. A batch open in the LOG hides "Working…" like an ask, push or no push.
  // The pendings and the URL bring tokens; the LOG says which batches are open, so one with no token
  // still gets its notice and its sheet, answered by session and batch id (2026-10-02).
  const openInLog = rows.flatMap((row) => (row.kind === 'questions' && row.end === undefined ? [{ id: row.id, count: row.questions.length }] : []))
  const batches = running ? withLogBatches(id, questionsFor(id, view.pending, view.search), openInLog) : []
  const [sheetTag, setSheetTag] = useState<string | undefined>(undefined)
  const askingQuestions = running && rows.some((row) => row.kind === 'questions' && row.end === undefined)
  // The batch the sheet showed is gone (answered, and its pending resolved): no overlay without a sheet,
  // or an ask arriving next would wait behind nothing.
  const sheetGone = view.overlay === QUESTIONS && !batches.some((batch) => batch.tag === sheetTag)
  useEffect(() => {
    if (sheetGone) view.setOverlay(undefined)
  }, [sheetGone])
  const agents = useMemo(() => {
    const byTask = new Map<string, string>()
    for (const event of events) if (event.kind === 'subagent' && event.phase === 'started') byTask.set(event.task, event.agent)
    return byTask
  }, [events])

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
        {/* Two lines: whose it is, small, over what it is, large. How it stands goes to the right. */}
        <div class="title s-head">
          <p class="s-head-project">
            <Icon name="folder-simple" size={14} />
            {project?.name ?? summary?.siteId ?? ''}
          </p>
          <h1>{summary === undefined ? id.slice(0, 8) : nameOf(summary)}</h1>
        </div>
        <span class={`s-status s-state-${state}`} title={stateLabel(state)}>
          <Icon name={STATE_GLYPH[state]} size={14} />
          <span class="s-status-text">{stateLabel(state)}</span>
        </span>
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
          <button type="button" class="icon-btn s-narrow-only" aria-label="New session" onClick={() => view.navigate('new')}>
            <Icon name="note-pencil" />
          </button>
        )}
        {summary === undefined ? null : (
          <ConversationMenu api={api} summary={summary} projectLabel={project?.name ?? summary.siteId} running={running} onChanged={onChanged} onDeleted={() => {
            onChanged()
            view.navigate('new')
          }} />
        )}
      </header>
      {showDetails ? <Details id={id} summary={summary} setup={setup} now={Date.now()} /> : null}
      {other === undefined ? null : <Strip pending={other} onOpen={(to) => view.navigate(to)} />}
      <div class="s-body">
        <Log
          rows={rows}
          running={running}
          asking={ask !== undefined}
          onOpenQuestions={(batchId) => {
            const batch = batches.find((b) => b.batch === batchId)
            if (batch === undefined) return
            setSheetTag(batch.tag)
            view.setOverlay(QUESTIONS)
          }}
        />
        {/* A subagent at work says so, which, and for how long — also while an ask waits, since it may
            be the one asking. Without one, "Working…" as before. */}
        {open.length > 0 ? <SubagentLines open={open} /> : null}
        {/* Where the next line will appear, so the eye is already there. Not while it waits on the owner. */}
        {running && open.length === 0 && ask === undefined && !askingQuestions ? (
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
        {batches.map((batch, index) => (
          <QuestionsArea
            key={batch.tag}
            view={view}
            batch={batch}
            agents={agents}
            first={index === 0}
            shown={view.overlay === QUESTIONS && sheetTag === batch.tag}
            show={() => {
              setSheetTag(batch.tag)
              view.setOverlay(QUESTIONS)
            }}
          />
        ))}
        {running ? null : (
          <ReplyComposer
            api={api}
            setup={setup}
            sessionId={id}
            project={summary === undefined ? undefined : { id: summary.siteId, label: project?.name ?? summary.siteId, color: project?.color }}
            onSent={restart}
            goTo={(to) => view.navigate(to)}
          />
        )}
      </div>
    </div>
  )
}

/** How often the time on a subagent line moves. */
const TICK_MS = 1_000

/**
 * One line per subagent at work: which, what for, and for how long (spec 2026-10-01-subagentes, D7).
 * The only component here with a timer, and only while it has a line to keep; the time counts from
 * the subagent's start in the log, so a reload does not reset it. The time is hidden from a screen
 * reader, which would otherwise read it out every second.
 */
function SubagentLines({ open }: { readonly open: readonly SubagentRow[] }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return (
    <ul class="s-sublines" role="status">
      {open.map((row) => (
        <li key={row.seq} class="s-subline">
          <Icon name="circle-notch" size={16} />
          <span class="s-subline-what">
            <span class="s-subline-agent">{row.agent}</span> · {row.description}
            {row.background ? ' · background' : ''}
          </span>
          <span class="s-subline-time num" aria-hidden="true">
            {duration(row.startedAt, undefined, now)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The ask this session waits on: a notice in the dock, and the sheet, which opens once by itself. */
function AskArea({ view, ask, setup }: { readonly view: ViewProps; readonly ask: AskRef; readonly setup: EngineSetupView }) {
  const { api, overlay, setOverlay, resolvePending } = view
  const { state, answer } = useAsk(api, ask, resolvePending)
  // DECIDED ONCE, ON ARRIVAL (spec 2026-10-01-preguntas-con-opciones, D12): with a batch of questions
  // open, the ask stays a notice until it is tapped — also after the sheet closes. Marked whether or
  // not it opened, so it never opens itself later over something the owner closed.
  const decided = useRef(false)
  const close = useCallback(() => setOverlay(undefined), [setOverlay])
  const sitePath = setup.sites.find((site) => site.id === ask.siteId)?.path

  useEffect(() => {
    if (decided.current || state.kind === 'over') return
    const opens = mayOpenItself(overlay, decided.current)
    decided.current = true
    if (opens) setOverlay(ASK)
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

/**
 * One batch of questions this session waits on: a notice in the dock and, when shown, the sheet. THE
 * DRAFT LIVES HERE, not in the sheet, so closing the sheet — by an ask, by Escape, by Back — and opening
 * it again loses nothing. Reloading the page does (accepted, requirements §6).
 */
function QuestionsArea({
  view,
  batch,
  agents,
  first,
  shown,
  show,
}: {
  readonly view: ViewProps
  readonly batch: QuestionsRef
  readonly agents: ReadonlyMap<string, string>
  /** Only the soonest batch may open itself; the others wait in the dock. */
  readonly first: boolean
  readonly shown: boolean
  readonly show: () => void
}) {
  const { api, overlay, setOverlay, resolvePending } = view
  const { load, info, failure, send } = useBatch(api, batch, resolvePending)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const decided = useRef(false)
  const close = useCallback(() => setOverlay(undefined), [setOverlay])
  const state = sheetState(load)

  useEffect(() => {
    if (info !== undefined && draft === undefined) setDraft(emptyDraft(info.questions))
  }, [info, draft])

  // Decided once, when it can first be shown (design D12), and marked whether or not it opened.
  useEffect(() => {
    if (decided.current || !state.opens) return
    const opens = first && mayOpenItself(overlay, decided.current)
    decided.current = true
    if (opens) show()
  }, [state.opens])

  // Sent, or found over: the sheet goes, and the notice says how it ended.
  useEffect(() => {
    if (shown && !state.opens) close()
  }, [shown, state.opens, close])

  if (shown && state.opens && info !== undefined && draft !== undefined) {
    return (
      <QuestionsSheet
        info={info}
        draft={draft}
        setDraft={setDraft}
        by={askedBy(info.task ?? undefined, agents)}
        send={async () => await send(draft)}
        onClose={close}
      />
    )
  }
  return (
    <div class={state.opens || load.kind === 'loading' ? 'notice ask' : 'notice'} role="status">
      <div class="head">
        <Icon name="list" size={16} />
        {failure ?? state.notice}
      </div>
      {state.opens ? (
        <div class="acts">
          <button type="button" class="btn" onClick={show}>
            Answer
          </button>
        </div>
      ) : null}
    </div>
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

