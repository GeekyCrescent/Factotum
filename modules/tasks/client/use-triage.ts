/**
 * Triage's data and its decisions, shared by the phone's screen (`triage.tsx`) and the board's Triage
 * column on a wide screen (`triage-card.tsx`) — design D11, criteria 19–23c.
 *
 * THE LIST is `GET /triage`, read again every `POLL_MS` while a card is still being read and the page
 * is visible, for at most `POLL_TICKS` reads (crit. 23c), and again when the tab comes back.
 *
 * A DECISION — accept to Todo or Backlog, or discard — posts, reads the list again, puts the focus on
 * the card that took the decided one's place (its own button, never straight onto a decision: a second
 * Enter must not accept a card nobody looked at), and says what it did.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { Task } from '../types.ts'
import type { Api } from './contract.ts'
import { messageOf } from './model.ts'
import { anyReading } from './triage-model.ts'

/** As the inbox: often enough to see a card land, rare enough to cost nothing. */
export const POLL_MS = 2_000
/**
 * Two minutes of polling: a read times out at 30 s and waits at most behind a few others. A card still
 * `pending` after that is one a dead daemon left, which the next start settles.
 */
const POLL_TICKS = 60

export interface TriageList {
  readonly tasks: readonly Task[]
  readonly pending: number
}

/**
 * `enabled` false reads nothing, and forgets the list: the board on a phone shows only the count.
 * `version` is anything that changes when Triage may have changed (the board's count of it): a new
 * card from an agent or a capture is read when the count moves, not at the next tab switch.
 */
export function useTriage(api: Api, enabled = true, version?: number) {
  const [list, setList] = useState<TriageList | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const reads = useRef({ started: 0, applied: 0 })

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++reads.current.started
    try {
      const next = await api.get<TriageList>('triage')
      if (mine < reads.current.applied) return
      reads.current.applied = mine
      setList(next)
      setError(undefined)
    } catch (cause) {
      if (mine >= reads.current.applied) setError(messageOf(cause))
    }
  }, [api])

  const [visits, setVisits] = useState(0)
  useEffect(() => {
    if (!enabled) {
      setList(undefined)
      return
    }
    void reload()
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void reload()
      setVisits((n) => n + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reload, enabled, version])

  const reading = enabled && list !== undefined && anyReading(list.tasks)
  // `visits` re-arms a polling that ran out, when the owner comes back to the tab.
  useEffect(() => {
    if (!reading) return
    let ticks = 0
    const handle = window.setInterval(() => {
      if (++ticks >= POLL_TICKS) window.clearInterval(handle)
      if (document.visibilityState === 'visible') void reload()
    }, POLL_MS)
    return () => window.clearInterval(handle)
  }, [reading, reload, visits])

  const clearError = useCallback(() => setError(undefined), [])
  return { list, error, reload, clearError }
}

export type Decision = 'todo' | 'backlog' | 'discard'

const DONE_LINE: Readonly<Record<Decision, string>> = {
  todo: 'Moved to Todo.',
  backlog: 'Moved to Backlog.',
  discard: 'Discarded.',
}

/** What the status line says after a decision: what happened, and how many are left. */
export function decidedLine(said: string, left: number): string {
  if (said === '') return ''
  return `${said} ${left === 0 ? 'Nothing left to sort.' : `${left} left.`}`
}

/**
 * Decide on one card. `act` posts and reads again (the board and the list); `tasks` is the list as it
 * is now, so the focus lands once the decided card has left it. `fallback` takes the focus when the
 * last card is gone and there is no lead line to give it to (the board's column).
 */
export function useDecide(
  act: (path: string, body?: unknown) => Promise<boolean>,
  tasks: readonly Task[] | undefined,
  fallback?: { readonly current: HTMLElement | null },
) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  // The guard reads THIS, not the render's `busy`: two taps before the next render must not post twice.
  const inFlight = useRef(new Set<string>())
  const [said, setSaid] = useState('')
  const [focusAt, setFocusAt] = useState<number | undefined>(undefined)
  const listRef = useRef<HTMLUListElement>(null)
  const leadRef = useRef<HTMLParagraphElement>(null)

  const decide = async (id: string, index: number, what: Decision): Promise<void> => {
    if (inFlight.current.has(id)) return
    inFlight.current.add(id)
    setBusy((was) => new Set(was).add(id))
    const path = `tasks/${encodeURIComponent(id)}/${what === 'discard' ? 'remove' : 'accept'}`
    const sent = await act(path, what === 'discard' ? undefined : { to: what })
    inFlight.current.delete(id)
    setBusy((was) => {
      const next = new Set(was)
      next.delete(id)
      return next
    })
    if (!sent) return
    setSaid(DONE_LINE[what])
    setFocusAt(index)
  }

  // After the list changed: the card that took the decided one's place, the one before it, or the lead.
  // A list that went away (the board's column closes with its last card) counts as an empty one.
  useEffect(() => {
    if (focusAt === undefined) return
    setFocusAt(undefined)
    const items = listRef.current?.querySelectorAll<HTMLElement>('[data-triage-first]') ?? []
    const target = items[Math.min(focusAt, items.length - 1)]
    if (target !== undefined) target.focus()
    else (leadRef.current ?? fallback?.current)?.focus()
  }, [focusAt, tasks, fallback])

  return { decide, busy, said, listRef, leadRef }
}
