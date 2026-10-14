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
 * another host that came back unanswered (criterion 31b). The id is pasted; its host is the project's,
 * or the board's when the card has none.
 */

import { useEffect, useState } from 'preact/hooks'
import type { SessionLink, Task } from '../types.ts'
import { linkedState, type LinkedRead, type LinkedState } from './agent-model.ts'
import { within, type Edge } from './edge.ts'
import { Icon } from './icon.tsx'
import { RunAgentSheet } from './run-agent.tsx'
import { toClientHost } from './where.ts'

export const LINK_TIMEOUT_MS = 5_000
/** The shape `uuidv7` produces: what the board accepts as a session id. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

interface Row {
  readonly link: SessionLink
  readonly state: LinkedState | 'reading'
  readonly title: string | undefined
}

const STATE_LABEL: Readonly<Record<Row['state'], string>> = {
  reading: 'Reading…',
  running: 'Running',
  finished: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  deleted: 'Deleted',
  unreachable: 'Unreachable',
  unknown: 'Unknown',
}

function useLinked(task: Task, edge: Edge): readonly Row[] {
  const [rows, setRows] = useState<readonly Row[]>(() => task.sessions.map((link) => ({ link, state: 'reading', title: undefined })))
  const where = edge.where
  const key = task.sessions.map((s) => `${s.host ?? ''}/${s.sessionId}`).join('|')
  const { peerModule, hosts } = edge
  // The hosts list is refreshed every few seconds as a new array: read again only when it CHANGES.
  const hostsKey = hosts.map((h) => `${h.name}:${h.reachable ? 1 : 0}`).join('|')
  const whereKey = where === undefined ? '' : `${where.boardHost ?? ''}|${where.selfName}`
  useEffect(() => {
    if (where === undefined) return
    let alive = true
    const reads = task.sessions.map(async (link): Promise<Row> => {
      const host = toClientHost(link.host, where)
      const api = host !== undefined && !hosts.some((h) => h.name === host) ? undefined : peerModule('sessions', host)
      let read: LinkedRead = 'no-host'
      let title: string | undefined
      if (api !== undefined) {
        try {
          // `{ summary, project }`: the state and the titles live in the summary.
          const body = await within(
            api.get<{ summary?: { state?: unknown; title?: unknown; autoTitle?: unknown; prompt?: unknown } }>(`sessions/${encodeURIComponent(link.sessionId)}`),
            LINK_TIMEOUT_MS,
          )
          const value = body.summary ?? {}
          read = { ok: true, value }
          // The owner's title, the titler's, or the start of the prompt — the sessions module's own order.
          const named = [value.title, value.autoTitle, value.prompt].find((one) => typeof one === 'string' && one.trim() !== '')
          title = typeof named === 'string' ? named : undefined
        } catch (cause) {
          read = { ok: false, cause }
        }
      }
      return { link, state: linkedState(read), title }
    })
    void Promise.all(reads).then((all) => {
      if (alive) setRows(all)
    })
    return () => {
      alive = false
    }
    // `key`, `whereKey` and `hostsKey` stand for the links, `where` and `hosts`: the same, the same reads.
  }, [key, whereKey, hostsKey, peerModule])
  return rows
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
  const rows = useLinked(task, edge)
  const [running, setRunning] = useState(false)
  const [linking, setLinking] = useState(false)
  const where = edge.where
  const canRun = !readOnly && task.project !== null && task.status !== 'triage'

  return (
    <section class="t-sessions" aria-label="Sessions">
      <h3>Sessions</h3>
      {rows.length === 0 ? <p class="dim-2">No session linked.</p> : null}
      <ul>
        {rows.map((row) => {
          const host = where === undefined ? undefined : toClientHost(row.link.host, where)
          const open = (): void => edge.openModule('sessions', encodeURIComponent(row.link.sessionId), { host: host ?? null })
          return (
            <li key={`${row.link.host ?? ''}/${row.link.sessionId}`}>
              <button type="button" class="t-session-row" disabled={row.state === 'deleted' || row.state === 'unreachable'} onClick={open}>
                <span class={`t-session-state t-session-${row.state}`}>{STATE_LABEL[row.state]}</span>
                <span class="t-session-title">{row.title ?? `Session ${row.link.sessionId.slice(-6)}`}</span>
                {row.link.host === null ? null : <span class="dim-3">on {row.link.host}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      {readOnly ? null : (
        <div class="t-sessions-acts">
          {canRun ? (
            <button type="button" class="btn sm" disabled={where === undefined} onClick={() => setRunning(true)}>
              <Icon name="terminal-window" size={16} />
              Run agent
            </button>
          ) : null}
          {task.status === 'triage' ? null : (
            <button type="button" class="btn sm quiet" onClick={() => setLinking((was) => !was)} aria-expanded={linking}>
              Link a session
            </button>
          )}
        </div>
      )}
      {linking ? <LinkForm task={task} act={act} onDone={() => setLinking(false)} /> : null}
      {running ? <RunAgentSheet task={task} edge={edge} act={act} onClose={() => setRunning(false)} /> : null}
    </section>
  )
}

function LinkForm({ task, act, onDone }: { readonly task: Task; readonly act: (path: string, body?: unknown) => Promise<boolean>; readonly onDone: () => void }) {
  const [id, setId] = useState('')
  const valid = SESSION_ID.test(id.trim())
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault()
    if (!valid) return
    // The project's host, as stored: the session ran where the project is. The board's without one.
    if (await act(`tasks/${encodeURIComponent(task.id)}/sessions`, { host: task.project?.host ?? null, sessionId: id.trim() })) onDone()
  }
  return (
    <form class="t-link-form" onSubmit={(event) => void submit(event)}>
      <input
        type="text"
        value={id}
        placeholder="Paste a session id"
        aria-label="Session id"
        aria-invalid={id.trim() !== '' && !valid}
        onInput={(event) => setId((event.target as HTMLInputElement).value)}
      />
      <button type="submit" class="btn sm" disabled={!valid}>
        Link
      </button>
    </form>
  )
}
