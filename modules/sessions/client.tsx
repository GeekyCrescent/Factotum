/**
 * Three screens: launch, list, and one session. Plain on purpose — the visual design
 * is a separate spec and this is legibility and nothing more.
 *
 * `api` arrives already prefixed to `/modules/sessions/`, so these screens cannot call
 * another module's routes without writing the whole path out by hand. Everything this
 * file touches from the outside is declared STRUCTURALLY, including the api and the
 * shape of a failed request, because a module depends on `packages/core` and only on
 * core (CLAUDE.md §1) and importing a class to read an error would break that.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { EngineSetupView, EventPage, SessionEvent, SessionPage, SessionSummary } from './types.ts'

interface Api {
  get: <T>(path: string) => Promise<T>
  post: <T>(path: string, body?: unknown) => Promise<T>
}

interface Props {
  readonly api: Api
}

/** How often the cursor asks again while a session is running. Criterion 8 allows 2s. */
const POLL_MS = 1_000

// ---------------------------------------------------------------------------
// Reading a failure structurally
// ---------------------------------------------------------------------------

interface Conflict {
  readonly sessionId: string
}

interface Freshness {
  readonly clean: boolean
  readonly behind: number
  readonly dirtyFiles: readonly string[]
  readonly remoteWarning?: string
}

/**
 * The 409 body, read WITHOUT importing anything.
 *
 * The client shell hangs `status` and `body` on an ordinary `Error` rather than
 * exporting a class, precisely so that this can be a cast instead of an import — a
 * class is a value at runtime, and reading one with `instanceof` would mean importing
 * from outside this module's one permitted dependency.
 */
function conflictOf(cause: unknown): Conflict | undefined {
  const error = cause as { status?: number; body?: { conflict?: { sessionId?: string } } }
  return error?.status === 409 && typeof error.body?.conflict?.sessionId === 'string'
    ? { sessionId: error.body.conflict.sessionId }
    : undefined
}

function freshnessOf(cause: unknown): Freshness | undefined {
  const error = cause as { status?: number; body?: { freshness?: Freshness } }
  return error?.status === 409 && error.body?.freshness !== undefined ? error.body.freshness : undefined
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function describe(report: Freshness): string {
  const parts: string[] = []
  if (report.behind > 0) parts.push(`${report.behind} commit${report.behind === 1 ? '' : 's'} behind`)
  if (!report.clean) parts.push(`uncommitted: ${report.dirtyFiles.join(', ')}`)
  if (report.remoteWarning !== undefined) parts.push(report.remoteWarning)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

type View = { readonly at: 'home' } | { readonly at: 'session'; readonly id: string }

function SessionsView({ api }: Props) {
  const [view, setView] = useState<View>({ at: 'home' })
  return view.at === 'home' ? (
    <Home api={api} open={(id) => setView({ at: 'session', id })} />
  ) : (
    <Session api={api} id={view.id} back={() => setView({ at: 'home' })} />
  )
}

function Home({ api, open }: Props & { open: (id: string) => void }) {
  const [setup, setSetup] = useState<EngineSetupView | undefined>(undefined)
  const [page, setPage] = useState<SessionPage | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = useCallback(async () => {
    const [nextSetup, nextPage] = await Promise.all([
      api.get<EngineSetupView>('setup'),
      api.get<SessionPage>('sessions?page=0'),
    ])
    setSetup(nextSetup)
    setPage(nextPage)
  }, [api])

  useEffect(() => {
    void refresh().catch((cause: unknown) => setError(messageOf(cause)))
  }, [refresh])

  if (error !== undefined) return <p class="notice">{error}</p>
  if (setup === undefined || page === undefined) return <p>…</p>

  return (
    <>
      <Launch api={api} setup={setup} open={open} onLaunched={() => void refresh()} />
      <List page={page} open={open} />
    </>
  )
}

// ---------------------------------------------------------------------------
// G2 — launch
// ---------------------------------------------------------------------------

function Launch({
  api,
  setup,
  open,
  onLaunched,
}: Props & { setup: EngineSetupView; open: (id: string) => void; onLaunched: () => void }) {
  const usable = setup.catalog.filter((entry) => entry.disabledReason === undefined)
  const [siteId, setSiteId] = useState(setup.sites[0]?.id ?? '')
  const [entryId, setEntryId] = useState(usable[0]?.id ?? '')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<Conflict | undefined>(undefined)
  const [stale, setStale] = useState<Freshness | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const send = async (force: boolean) => {
    setBusy(true)
    setConflict(undefined)
    setStale(undefined)
    setError(undefined)
    try {
      const result = await api.post<{ sessionId: string }>('sessions', { siteId, entryId, text, force })
      setText('')
      onLaunched()
      open(result.sessionId)
    } catch (cause: unknown) {
      // Criterion 17 and criterion 12, both read off the body the error now carries.
      const busySite = conflictOf(cause)
      const notFresh = freshnessOf(cause)
      if (busySite !== undefined) setConflict(busySite)
      else if (notFresh !== undefined) setStale(notFresh)
      else setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  if (setup.sites.length === 0) {
    return (
      <div class="notice">
        <h1>No sites</h1>
        <p>
          Declare one under <code>modules.sessions.sites</code> in{' '}
          <code>~/.factotum/&lt;env&gt;/config.json</code> and restart. Nothing is allowed by being
          inside a folder — a site is allowed because you wrote it down.
        </p>
      </div>
    )
  }

  return (
    <>
      <h1>Launch</h1>
      <p>
        <label>
          Site{' '}
          <select value={siteId} onChange={(e) => setSiteId((e.target as HTMLSelectElement).value)}>
            {setup.sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.id}
                {site.isRepo ? ' (git)' : ''}
              </option>
            ))}
          </select>
        </label>
      </p>
      <p>
        <label>
          What{' '}
          <select value={entryId} onChange={(e) => setEntryId((e.target as HTMLSelectElement).value)}>
            {usable.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </p>
      <p>
        <textarea
          rows={4}
          style="width:100%"
          value={text}
          placeholder="What should it do?"
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />
      </p>
      <p>
        <button disabled={busy || text.trim() === '' || entryId === ''} onClick={() => void send(false)}>
          {busy ? 'Launching…' : 'Launch'}
        </button>
      </p>

      {setup.catalog.some((entry) => entry.disabledReason !== undefined) ? (
        <div class="notice">
          {setup.catalog
            .filter((entry) => entry.disabledReason !== undefined)
            .map((entry) => (
              <p key={entry.id}>
                <strong>{entry.label}</strong> is disabled: <code>{entry.disabledReason}</code>
              </p>
            ))}
        </div>
      ) : null}

      {conflict !== undefined ? (
        <div class="notice">
          <p>That site already has a live session.</p>
          <p>
            <button onClick={() => open(conflict.sessionId)}>Go to it</button>{' '}
            <button
              onClick={() => {
                void api.post(`sessions/${conflict.sessionId}/cancel`).then(() => {
                  setConflict(undefined)
                  onLaunched()
                })
              }}
            >
              Cancel it
            </button>
          </p>
        </div>
      ) : null}

      {stale !== undefined ? (
        <div class="notice">
          <p>That site is not clean or not up to date: {describe(stale)}</p>
          <p>
            <button onClick={() => void send(true)}>Launch anyway</button>
          </p>
        </div>
      ) : null}

      {error !== undefined ? <p class="notice">{error}</p> : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// G3 — the list
// ---------------------------------------------------------------------------

function List({ page, open }: { page: SessionPage; open: (id: string) => void }) {
  if (page.sessions.length === 0) return <p>No sessions yet.</p>
  return (
    <>
      <h1>Sessions</h1>
      <ul>
        {page.sessions.map((session) => (
          <li key={session.id}>
            <a
              href={`#${session.id}`}
              onClick={(e) => {
                e.preventDefault()
                open(session.id)
              }}
            >
              {short(session)}
            </a>
          </li>
        ))}
      </ul>
    </>
  )
}

function short(session: SessionSummary): string {
  const when = new Date(session.startedAt)
  const stamp = Number.isNaN(when.getTime()) ? session.startedAt : when.toLocaleString()
  return `${session.id.slice(0, 8)} · ${session.siteId} · ${session.entryId} · ${session.state} · ${stamp}`
}

// ---------------------------------------------------------------------------
// G4 — one session, followed with a cursor
// ---------------------------------------------------------------------------

function Session({ api, id, back }: Props & { id: string; back: () => void }) {
  const [events, setEvents] = useState<readonly SessionEvent[]>([])
  const [state, setState] = useState<SessionSummary['state']>('running')
  const [error, setError] = useState<string | undefined>(undefined)
  const [text, setText] = useState('')
  const [conflict, setConflict] = useState<Conflict | undefined>(undefined)
  /** Bumped by a reply, which is what restarts the polling a finished session stopped. */
  const [generation, setGeneration] = useState(0)
  const cursor = useRef(0)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined

    /**
     * The cursor, and the reason there is no race here to get wrong: THE LOG IS THE
     * CURSOR. A reconnect is the same request with a different number, so nothing has
     * to be buffered while the file is read and nothing has to be de-duplicated
     * afterwards. The thing this replaces needed sixty-odd lines to do that safely.
     */
    const poll = async () => {
      try {
        const page = await api.get<EventPage>(`sessions/${id}/events?fromSeq=${cursor.current}`)
        if (!live) return
        if (page.events.length > 0) {
          cursor.current = page.nextSeq
          setEvents((previous) => [...previous, ...page.events])
        }
        setState(page.state)
        // Stop the moment it is over. Polling a finished session for ever is a phone
        // battery spent on a file that cannot change again.
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

  const reply = async () => {
    setConflict(undefined)
    setError(undefined)
    try {
      await api.post(`sessions/${id}/reply`, { text })
      setText('')
      setState('running')
      // Re-runs the effect above, rather than a second copy of the same loop.
      setGeneration((n) => n + 1)
    } catch (cause: unknown) {
      const busySite = conflictOf(cause)
      if (busySite !== undefined) setConflict(busySite)
      else setError(messageOf(cause))
    }
  }

  const cancel = async () => {
    try {
      await api.post(`sessions/${id}/cancel`)
      setGeneration((n) => n + 1)
    } catch (cause: unknown) {
      setError(messageOf(cause))
    }
  }

  return (
    <>
      <p>
        <button onClick={back}>← all sessions</button>
      </p>
      <h1>
        {id.slice(0, 8)} · {state}
      </h1>

      <ol>
        {events.map((event) => (
          <li key={event.seq}>
            <Line event={event} />
          </li>
        ))}
      </ol>

      {state === 'running' ? (
        <p>
          <button onClick={() => void cancel()}>Cancel</button>
        </p>
      ) : (
        <>
          <p>
            <textarea
              rows={3}
              style="width:100%"
              value={text}
              placeholder="Reply…"
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            />
          </p>
          <p>
            <button disabled={text.trim() === ''} onClick={() => void reply()}>
              Reply
            </button>
          </p>
        </>
      )}

      {conflict !== undefined ? (
        <p class="notice">
          That site is busy with session {conflict.sessionId.slice(0, 8)}. Cancel it first.
        </p>
      ) : null}
      {error !== undefined ? <p class="notice">{error}</p> : null}
    </>
  )
}

function Line({ event }: { event: SessionEvent }) {
  switch (event.kind) {
    case 'message':
      return (
        <span>
          <strong>{event.role}</strong>: {event.text}
        </span>
      )
    case 'tool':
      return (
        <span>
          <strong>{event.name}</strong> <code>{JSON.stringify(event.input)}</code>
        </span>
      )
    case 'result':
      return (
        <span>
          {event.ok ? '✓' : '✗'} <strong>{event.name}</strong> {event.summary}
        </span>
      )
    case 'state':
      return (
        <span>
          <em>{event.state}</em>
          {event.reason === undefined ? '' : ` — ${event.reason}`}
        </span>
      )
  }
}

export const sessionsClient = { id: 'sessions', View: SessionsView }
