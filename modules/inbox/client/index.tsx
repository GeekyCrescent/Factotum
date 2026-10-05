/**
 * The mail digest's client (spec 2026-10-05, D9). No drawer of its own — it shows in the drawer's
 * foot like any module without one — no settings, and the shell's bar on top.
 *
 * WHAT `rest` MEANS: `''` is the latest check and the button; `history` the list; a digest id that
 * one check. Anything else goes back to `''`.
 */

import './client.css'
import { useEffect } from 'preact/hooks'
import { DIGEST_ID } from '../types.ts'
import type { ViewProps } from './contract.ts'
import { DigestView } from './digest-view.tsx'
import { History } from './history.tsx'

const HISTORY = 'history'

function InboxView(view: ViewProps) {
  const { rest, navigate } = view
  const known = rest === '' || rest === HISTORY || DIGEST_ID.test(rest)

  useEffect(() => {
    if (!known) navigate('', { replace: true })
  }, [known, navigate])

  if (rest === HISTORY) return <History view={view} />
  if (rest !== '' && known) return <DigestView key={rest} view={view} id={rest} />
  return <DigestView key="latest" view={view} />
}

export const inboxClient = { id: 'inbox', View: InboxView }
