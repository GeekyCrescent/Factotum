/**
 * The drawer's arrangement as the owner sees it: the daemon's, or — while a change is on its way —
 * the change itself, so a drop lands at once rather than a round trip later.
 *
 * IN ORDER, ONE AT A TIME. Each change is the whole layout, built on the one before it, and they are
 * posted in a queue: two drops in a row cannot arrive the wrong way round. When the last one has
 * landed, the drawer reads the projects again and shows the daemon's. When one FAILS — a project
 * added on another device makes it stale — the error is said, the drawer reads the daemon's again,
 * and what was dropped goes back where the daemon has it.
 */

import { useRef, useState } from 'preact/hooks'
import type { ProjectsPage } from '../types.ts'
import type { Api } from './contract.ts'
import { messageOf } from './errors.ts'
import { layoutOf, reconcile, sameLayout, type Layout } from './layout.ts'

const EMPTY: Layout = { categories: [], order: [] }

export function useProjectLayout(api: Api, page: ProjectsPage | undefined, refetch: () => Promise<void>) {
  const [sending, setSending] = useState<Layout | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const latest = useRef(0)

  const served = page === undefined ? EMPTY : layoutOf(page.projects, page.categories)
  const layout = sending === undefined ? served : reconcile(sending, page?.projects.map((p) => p.id) ?? [])

  const change = (next: Layout): void => {
    if (sameLayout(next, layout)) return
    const mine = ++latest.current
    setSending(next)
    setFailure(undefined)
    queue.current = queue.current.then(async () => {
      try {
        await api.post('project-layout', next)
      } catch (cause: unknown) {
        setFailure(messageOf(cause))
      }
      // Only the last one reads back: an earlier one would show its own layout under a newer drop.
      if (mine !== latest.current) return
      try {
        await refetch()
      } finally {
        if (mine === latest.current) setSending(undefined)
      }
    })
    // A read that failed must not stop the next change from being sent: the drawer polls anyway.
    queue.current = queue.current.catch(() => undefined)
  }

  return { layout, change, failure, clearFailure: () => setFailure(undefined) }
}
