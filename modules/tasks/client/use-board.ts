/**
 * The board as the daemon has it, and every change sent to it (design D11).
 *
 * NO OPTIMISM: a change is posted and the board read again. A single owner on a tailnet gets the
 * answer in milliseconds (criterion 4 measured ~10 ms for 2 000 cards), and a board that only ever
 * shows the daemon's state cannot drift from it.
 *
 * IN ORDER, ONE AT A TIME: two drops in a row are posted in a queue, so they cannot land the wrong way
 * round. The board is read again when the tab comes back into view.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { BoardView } from '../types.ts'
import type { Api } from './contract.ts'
import { messageOf } from './model.ts'

export interface BoardState {
  readonly view: BoardView | undefined
  readonly error: string | undefined
  readonly clearError: () => void
  readonly reload: () => Promise<void>
  /** Posts, reads the board again, and resolves with whether the post went through. */
  readonly act: (path: string, body?: unknown) => Promise<boolean>
}

export function useBoard(api: Api): BoardState {
  const [view, setView] = useState<BoardView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const reload = useCallback(async (): Promise<void> => {
    try {
      setView(await api.get<BoardView>('board'))
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [api])

  useEffect(() => {
    void reload()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reload])

  const act = useCallback(
    (path: string, body?: unknown): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        let sent = false
        try {
          await api.post(path, body)
          setError(undefined)
          sent = true
        } catch (cause) {
          setError(messageOf(cause))
        }
        await reload()
        return sent
      }
      const next = queue.current.then(run, run)
      queue.current = next
      return next
    },
    [api, reload],
  )

  const clearError = useCallback(() => setError(undefined), [])
  return { view, error, clearError, reload, act }
}

/** `true` from 900 px: six columns. Below, one column at a time with tabs (criterion 7). */
export function useWide(): boolean {
  const query = '(min-width: 900px)'
  const [wide, setWide] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const list = window.matchMedia(query)
    const onChange = () => setWide(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [])
  return wide
}
