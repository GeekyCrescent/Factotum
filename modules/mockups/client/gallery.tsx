/**
 * The gallery — direction B (K2): tiles with a border and no shadow, the track as five segments,
 * «waiting on you» and «stalled» first (criterion 38), the production URL when there is one, and the
 * warning of criterion 2b on top.
 *
 * The warning compares paths WITHOUT CASE: the module runs on the Mac (D1), where `sessions` does too.
 */

import { useEffect, useState } from 'preact/hooks'
import { STAGE_IDS, type Mockup, type MockupsSetup } from '../types.ts'
import type { ViewProps } from './contract.ts'
import { Glyph } from './glyph.tsx'
import { Icon } from './icon.tsx'
import { messageOf } from './launch.ts'
import { crossWrites, galleryOrder, nowStage, statusLine, type SessionsProjects } from './model.ts'

type Loaded = { readonly kind: 'loading' } | { readonly kind: 'ok'; readonly mockups: readonly Mockup[]; readonly setup: MockupsSetup } | { readonly kind: 'failed'; readonly message: string }

export function Gallery({ props }: { readonly props: ViewProps }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const [warning, setWarning] = useState<string | undefined>(undefined)
  const sessions = props.peerModule('sessions', props.host)

  useEffect(() => {
    let alive = true
    props.api
      .get<{ mockups: readonly Mockup[]; setup: MockupsSetup }>('mockups')
      .then(async (answer) => {
        if (!alive) return
        setLoaded({ kind: 'ok', ...answer })
        if (sessions === undefined) return
        const page = await sessions.get<SessionsProjects>('projects').catch(() => undefined)
        if (alive && page !== undefined) setWarning(crossWrites(answer.setup, page, true))
      })
      .catch((cause: unknown) => alive && setLoaded({ kind: 'failed', message: messageOf(cause) }))
    return () => {
      alive = false
    }
  }, [props.api, sessions])

  return (
    <div class="mk-screen">
      <header class="mk-bar">
        <button type="button" class="btn quiet mk-icon-btn mk-burger" aria-label="Menu" onClick={props.openDrawer}>
          <Icon name="list" size={20} />
        </button>
        <h2 class="mk-title">Mockups</h2>
        <span class="mk-grow" />
        <button type="button" class="btn sm primary" onClick={() => props.navigate('new')}>
          <Icon name="plus" size={14} /> New mockup
        </button>
      </header>
      {sessions === undefined ? <p class="mk-notice mk-pad-x">sessions is not running on this host: you can read and decide, not launch stages.</p> : null}
      {warning === undefined ? null : (
        <p class="mk-notice mk-pad-x">
          <Icon name="warning" size={16} /> {warning}
        </p>
      )}
      {loaded.kind === 'loading' ? <div class="mk-skeleton mk-pad" aria-busy="true" /> : null}
      {loaded.kind === 'failed' ? <p class="mk-notice mk-err mk-pad-x">{loaded.message}</p> : null}
      {loaded.kind === 'ok' && loaded.mockups.length === 0 ? (
        <div class="mk-empty mk-pad">
          <Icon name="stack" size={28} />
          <p>No mockups yet. Start one from a client's RFP, a meeting or a few bullets: the brief reads them, and you approve it from the phone.</p>
        </div>
      ) : null}
      {loaded.kind === 'ok' ? (
        <div class="mk-grid">
          {galleryOrder(loaded.mockups).map((m) => (
            <Tile key={m.id} m={m} onOpen={() => props.navigate(m.id)} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Tile({ m, onOpen }: { readonly m: Mockup; readonly onOpen: () => void }) {
  const statuses = STAGE_IDS.map((id) => m.stages[id].status)
  const tone = statuses.includes('waiting') ? ' mk-need' : statuses.includes('stalled') ? ' mk-bad' : ''
  const at = nowStage(m)
  return (
    <button type="button" class={`mk-tile${tone}`} onClick={onOpen}>
      <span class="mk-tile-name">{m.name}</span>
      <span class="mk-sub">{m.client}</span>
      <span class="mk-segs" aria-hidden="true">
        {statuses.map((status, i) => (
          <span key={STAGE_IDS[i]} class={`mk-seg mk-seg-${status}`} />
        ))}
      </span>
      <span class="mk-tile-state">
        <Glyph status={m.stages[at].status} /> {at}: {statusLine(m.stages[at])}
      </span>
      {m.urls.prod === undefined ? null : <span class="mk-mono mk-ellipsis">{m.urls.prod}</span>}
    </button>
  )
}
