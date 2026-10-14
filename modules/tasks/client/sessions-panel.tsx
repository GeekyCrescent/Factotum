/**
 * The card's sessions (design D9; criteria 30–33): «Run agent» when the card has a project, the
 * sessions linked to it with what each is doing, and «Link a session» by hand.
 *
 * EACH LINKED SESSION IS READ on its own host — the stored host through `toClientHost`, so both apps
 * reach the same one (criterion 30b) — IN PARALLEL, `LINK_TIMEOUT_MS` each. A 404 is «deleted»; a host
 * not in `hosts`, or that does not answer, is «unreachable». Neither breaks the card (criterion 32).
 * A session that ends moves nothing: the card stays where the owner left it (criterion 33).
 *
 * «LINK A SESSION» covers a launch whose link never landed — the app closed in between, or a launch on
 * another host that came back unanswered (criterion 31b). The id is pasted; its host is the project's as
 * the board stores it, or `null` when the card has none.
 */

import { createPortal } from 'preact/compat'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { SessionLink, Task } from '../types.ts'
import { linkedState, type LinkedRead, type LinkedState } from './agent-model.ts'
import { within, type Edge } from './edge.ts'
import { Icon } from './icon.tsx'
import { RunAgentSheet } from './run-agent.tsx'
import { toClientHost } from './where.ts'

export const LINK_TIMEOUT_MS = 5_000
/** The shape `uuidv7` produces: what the board accepts as a session id. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

interface Read {
  readonly state: LinkedState | 'reading'
  readonly title: string | undefined
}

const STATE_LABEL: Readonly<Record<Read['state'], string>> = {
  reading: 'Reading…',
  running: 'Running',
  finished: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  deleted: 'Deleted',
  unreachable: 'Unreachable',
  unknown: 'Unknown',
}

const linkKey = (link: SessionLink): string => `${link.host ?? ''}/${link.sessionId}`

/**
 * What each linked session is doing, as a map by link. The rows themselves come from `task.sessions`
 * ON EVERY RENDER: a link just added shows at once as «Reading…», and one removed goes at once. Each
 * read lands on its own, never waiting for the slowest host. `attempt` reads them all again (Retry).
 */
function useLinked(task: Task, edge: Edge, attempt: number): ReadonlyMap<string, Read> {
  const [reads, setReads] = useState<ReadonlyMap<string, Read>>(new Map())
  const where = edge.where
  const key = task.sessions.map(linkKey).join('|')
  const { peerModule, hosts } = edge
  // The hosts list is refreshed every few seconds as a new array: read again only when it CHANGES.
  const hostsKey = hosts.map((h) => `${h.name}:${h.reachable ? 1 : 0}`).join('|')
  const whereKey = where === undefined ? '' : `${where.boardHost ?? ''}|${where.selfName}`
  useEffect(() => {
    if (where === undefined) return
    let alive = true
    setReads(new Map())
    for (const link of task.sessions) {
      void readOne(link).then((read) => {
        if (alive) setReads((was) => new Map(was).set(linkKey(link), read))
      })
    }
    return () => {
      alive = false
    }

    async function readOne(link: SessionLink): Promise<Read> {
      if (where === undefined) return { state: 'unreachable', title: undefined }
      const host = toClientHost(link.host, where)
      const api = host !== undefined && !hosts.some((h) => h.name === host) ? undefined : peerModule('sessions', host)
      if (api === undefined) return { state: linkedState('no-host'), title: undefined }
      try {
        const body = await within(
          api.get<{ summary?: { state?: unknown; title?: unknown; autoTitle?: unknown; prompt?: unknown } }>(`sessions/${encodeURIComponent(link.sessionId)}`),
          LINK_TIMEOUT_MS,
        )
        const value = body.summary ?? {}
        // The owner's title, the titler's, or the start of the prompt — the sessions module's own order.
        const named = [value.title, value.autoTitle, value.prompt].find((one) => typeof one === 'string' && one.trim() !== '')
        return { state: linkedState({ ok: true, value }), title: typeof named === 'string' ? named : undefined }
      } catch (cause) {
        return { state: linkedState({ ok: false, cause }), title: undefined }
      }
    }
    // `key`, `whereKey` and `hostsKey` stand for the links, `where` and `hosts`: the same, the same reads.
  }, [key, whereKey, hostsKey, peerModule, attempt])
  return reads
}

/** While a sheet is open over the card, the card's sheet is `inert`: Tab and a screen reader stay on top. */
function useInertBelow(anchor: { readonly current: HTMLElement | null }, on: boolean): void {
  useEffect(() => {
    const below = anchor.current?.closest('.sheet')
    if (!on || below == null) return
    below.setAttribute('inert', '')
    return () => below.removeAttribute('inert')
  }, [anchor, on])
}

export function SessionsPanel({
  task,
  edge,
  readOnly,
  act,
}: {
  readonly task: Task
  readonly edge: Edge
  readonly readOnly: boolean
  readonly act: (path: string, body?: unknown) => Promise<boolean>
}) {
  const [attempt, setAttempt] = useState(0)
  const reads = useLinked(task, edge, attempt)
  const [running, setRunning] = useState(false)
  const [linking, setLinking] = useState(false)
  const section = useRef<HTMLElement>(null)
  useInertBelow(section, running)
  const where = edge.where
  const canRun = !readOnly && task.project !== null && task.status !== 'triage'

  return (
    <section class="t-sessions" aria-label="Sessions" ref={section}>
      <h3>Sessions</h3>
      {task.sessions.length === 0 ? <p class="dim-2">No session linked.</p> : null}
      <ul>
        {task.sessions.map((link) => {
          const read = reads.get(linkKey(link)) ?? { state: 'reading', title: undefined }
          const host = where === undefined ? undefined : toClientHost(link.host, where)
          const name = read.title ?? `Session ${link.sessionId.slice(-6)}`
          const label = (
            <>
              <span class={`t-session-state t-session-${read.state}`}>{STATE_LABEL[read.state]}</span>
              <span class="t-session-title">{name}</span>
              {link.host === null ? null : <span class="dim-3">on {link.host}</span>}
            </>
          )
          // A dead link is information, not a control: no button to be disabled, and a way to try again.
          if (read.state === 'deleted' || read.state === 'unreachable') {
            return (
              <li key={linkKey(link)} class="t-session-row t-session-dead">
                {label}
                {read.state === 'unreachable' ? (
                  <button type="button" class="btn sm quiet" onClick={() => setAttempt((n) => n + 1)}>
                    Retry
                  </button>
                ) : null}
              </li>
            )
          }
          return (
            <li key={linkKey(link)}>
              <button
                type="button"
                class="t-session-row"
                onClick={() => edge.openModule('sessions', encodeURIComponent(link.sessionId), { host: host ?? null })}
              >
                {label}
              </button>
            </li>
          )
        })}
      </ul>
      {readOnly ? null : (
        <div class="t-sessions-acts">
          {canRun ? (
            <button type="button" class="btn sm" disabled={where === undefined} title={where === undefined ? 'Waiting for the list of hosts' : undefined} onClick={() => setRunning(true)}>
              <Icon name="terminal-window" size={16} />
              Run agent
            </button>
          ) : null}
          {task.status === 'triage' ? null : (
            <button type="button" class="btn sm quiet" onClick={() => setLinking((was) => !was)} aria-expanded={linking} aria-controls="t-link-form">
              Link a session
            </button>
          )}
        </div>
      )}
      {linking ? <LinkForm task={task} act={act} onDone={() => setLinking(false)} /> : null}
      {/* Over the whole page, not inside the card's sheet: a sheet in a sheet would be clipped by it. */}
      {running ? createPortal(<RunAgentSheet task={task} edge={edge} act={act} onClose={() => setRunning(false)} />, document.body) : null}
    </section>
  )
}

function LinkForm({ task, act, onDone }: { readonly task: Task; readonly act: (path: string, body?: unknown) => Promise<boolean>; readonly onDone: () => void }) {
  const [id, setId] = useState('')
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => field.current?.focus(), [])
  const clean = id.trim().toLowerCase()
  const valid = SESSION_ID.test(clean)
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault()
    if (!valid) return
    // The project's host as stored: the session ran where the project is. Without a project, `null`.
    if (await act(`tasks/${encodeURIComponent(task.id)}/sessions`, { host: task.project?.host ?? null, sessionId: clean })) onDone()
  }
  return (
    <form id="t-link-form" class="t-link-form" onSubmit={(event) => void submit(event)}>
      <input
        ref={field}
        type="text"
        value={id}
        placeholder="Paste a session id"
        aria-label="Session id"
        aria-invalid={id.trim() !== '' && !valid}
        title={id.trim() !== '' && !valid ? 'Not a session id' : undefined}
        onInput={(event) => setId((event.target as HTMLInputElement).value)}
      />
      <button type="submit" class="btn sm" disabled={!valid}>
        Link
      </button>
    </form>
  )
}
