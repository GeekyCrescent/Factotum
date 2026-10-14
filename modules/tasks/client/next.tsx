/**
 * «What's next?», `/m/tasks/next` (design D11; criteria 38–40): a sheet over the board with up to seven
 * cards for today, each with why, and claude's note on the day.
 *
 * IT ASKS BY ITSELF ONLY WHEN THERE IS NOTHING OF TODAY to show: an answer from today is shown with «Ask
 * again», so opening the sheet twice does not spend two runs. The last answer stays until the next one
 * (criterion 40).
 *
 * WHILE CLAUDE THINKS the sheet reads `GET next` every `POLL_MS`, only while the page is visible, and
 * stops when the run is over. A start that finds one already running (`409`) just waits for it.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { BoardView, NextStatus } from '../types.ts'
import type { Api } from './contract.ts'
import { Icon } from './icon.tsx'
import { messageOf, statusOf } from './model.ts'
import { askedAt, nextRows, nextStage } from './next-model.ts'
import { Sheet } from './sheet.tsx'
import { POLL_MS } from './triage.tsx'

function useNext(api: Api) {
  const [status, setStatus] = useState<NextStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const reload = useCallback(async (): Promise<NextStatus | undefined> => {
    try {
      const next = await api.get<NextStatus>('next')
      setStatus(next)
      setError(undefined)
      return next
    } catch (cause) {
      setError(messageOf(cause))
      return undefined
    }
  }, [api])

  const ask = useCallback(async (): Promise<void> => {
    try {
      await api.post('next')
    } catch (cause) {
      // Already thinking (another tab, a double tap): wait for that run instead.
      if (statusOf(cause) !== 409) setError(messageOf(cause))
    }
    await reload()
  }, [api, reload])

  const running = status?.running === true
  useEffect(() => {
    if (!running) return
    const handle = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload()
    }, POLL_MS)
    return () => window.clearInterval(handle)
  }, [running, reload])

  return { status, error, reload, ask }
}

export function NextSheet({
  api,
  view,
  today,
  open,
  onClose,
}: {
  readonly api: Api
  readonly view: BoardView
  /** `YYYY-MM-DD` in the board's zone: an answer from another day is asked again. */
  readonly today: string
  readonly open: (id: string) => void
  readonly onClose: () => void
}) {
  const next = useNext(api)
  const asked = useRef(false)
  const { reload, ask } = next

  // Once, on opening: read where it stands, and ask when there is nothing of today to show.
  useEffect(() => {
    void (async () => {
      const first = await reload()
      if (first === undefined || asked.current) return
      asked.current = true
      const fresh = first.last !== null && askedAt(first.last.at, view.timeZone, today).startsWith('Today')
      if (!first.running && !fresh) await ask()
    })()
    // On mount only: the zone and the day do not change while the sheet is open.
  }, [])

  const status = next.status
  const stage = status === undefined ? undefined : nextStage(status)
  const thinking = stage === 'thinking'
  const foot = (
    <button type="button" class="btn primary" disabled={status === undefined || thinking} onClick={() => void ask()}>
      <Icon name="lightbulb" size={18} />
      {stage === 'never' || stage === 'failed' ? 'Ask' : 'Ask again'}
    </button>
  )

  return (
    <Sheet id="t-next-title" title="What's next?" onClose={onClose} foot={foot}>
      <div class="t-next">
        {next.error === undefined ? null : <p class="t-next-error">{next.error}</p>}
        {status?.error == null ? null : <p class="t-next-error">Couldn't get suggestions: {status.error}</p>}
        <p class="t-next-thinking" role="status">
          {thinking ? (
            <>
              <Icon name="circle-notch" size={16} class="t-spin" />
              Thinking about your day…
            </>
          ) : (
            ''
          )}
        </p>
        {status?.last == null ? (
          stage === 'never' && !thinking ? <p class="dim-2">Nothing asked yet.</p> : null
        ) : (
          <Answer last={status.last} view={view} today={today} open={open} />
        )}
      </div>
    </Sheet>
  )
}

function Answer({
  last,
  view,
  today,
  open,
}: {
  readonly last: NonNullable<NextStatus['last']>
  readonly view: BoardView
  readonly today: string
  readonly open: (id: string) => void
}) {
  const rows = nextRows(last.items, view.tasks)
  return (
    <>
      <p class="t-next-at dim-3">{askedAt(last.at, view.timeZone, today)}</p>
      {last.note === '' ? null : <p class="t-next-note">{last.note}</p>}
      {rows.length === 0 ? (
        <p class="dim-2">Nothing to suggest right now.</p>
      ) : (
        <ol class="t-next-list">
          {rows.map((row) => (
            <li key={row.task.id}>
              <button type="button" class="t-next-row" onClick={() => open(row.task.id)}>
                <span class="t-next-title">{row.task.title}</span>
                <span class="t-next-why dim-2">{row.why}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}
