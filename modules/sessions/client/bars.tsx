/**
 * The pieces of a bar this module draws for itself (`ownsTopBar: true`): the ☰ with the count of
 * everything pending, and the strip that says ANOTHER session is waiting. The classes are the
 * shell's (`.topbar`, `.icon-btn`, `.menu-button`, `.badge`), shared by name: this module imports
 * nothing from the shell.
 */

import { Icon } from './icon.tsx'
import { sessionOf, type Pending } from './relevance.ts'

export function MenuButton({ pendingTotal, onMenu }: { readonly pendingTotal: number; readonly onMenu: () => void }) {
  return (
    <button
      type="button"
      class="icon-btn menu-button"
      aria-label={pendingTotal > 0 ? `Sessions, ${pendingTotal} waiting for you` : 'Sessions'}
      onClick={onMenu}
    >
      <Icon name="list" size={22} />
      {pendingTotal > 0 ? (
        <span class="badge" aria-hidden="true">
          {pendingTotal}
        </span>
      ) : null}
    </button>
  )
}

export function TopBar({
  title,
  pendingTotal,
  onMenu,
}: {
  readonly title: string
  readonly pendingTotal: number
  readonly onMenu: () => void
}) {
  return (
    <header class="topbar">
      <MenuButton pendingTotal={pendingTotal} onMenu={onMenu} />
      <div class="title">
        <h1>{title}</h1>
      </div>
    </header>
  )
}

/** "proyecto-a is waiting for you", a tap away. */
export function Strip({ pending, onOpen }: { readonly pending: Pending; readonly onOpen: (sessionId: string) => void }) {
  const sessionId = sessionOf(pending)
  if (sessionId === undefined) return null
  const site = typeof pending.data['siteId'] === 'string' ? pending.data['siteId'] : 'A session'
  return (
    <button type="button" class="s-strip" onClick={() => onOpen(sessionId)}>
      <Icon name="hand" size={16} />
      <span>
        <b>{site}</b> is waiting for you
      </span>
      <span class="s-strip-go">
        Review
        <Icon name="caret-right" size={14} />
      </span>
    </button>
  )
}
