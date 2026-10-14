/**
 * The bar this module draws for itself (`ownsTopBar: true`, redesign A): the ☰ with the count of
 * everything pending, then whatever the screen puts in it. The classes are the shell's (`.topbar`,
 * `.icon-btn`, `.menu-button`, `.badge`), shared by name — the pattern of the sessions module's bar,
 * written again here because a module imports nothing from another. On a wide screen with the
 * sidebar open the shell hides the ☰.
 */

import type { ComponentChildren } from 'preact'
import { Icon } from './icon.tsx'

export function TopBar({
  pendingTotal,
  onMenu,
  children,
}: {
  readonly pendingTotal: number
  readonly onMenu: () => void
  readonly children: ComponentChildren
}) {
  return (
    <header class="topbar t-bar">
      <button
        type="button"
        class="icon-btn menu-button"
        aria-label={pendingTotal > 0 ? `Menu, ${pendingTotal} waiting for you` : 'Menu'}
        onClick={onMenu}
      >
        <Icon name="list" size={22} />
        {pendingTotal > 0 ? (
          <span class="badge" aria-hidden="true">
            {pendingTotal}
          </span>
        ) : null}
      </button>
      {children}
    </header>
  )
}

/** A screen under the bar that is not the board: a title, and the way back. */
export function PageBar({
  title,
  back,
  pendingTotal,
  onMenu,
}: {
  readonly title: string
  readonly back: { readonly label: string; readonly go: () => void }
  readonly pendingTotal: number
  readonly onMenu: () => void
}) {
  return (
    <TopBar pendingTotal={pendingTotal} onMenu={onMenu}>
      <div class="title">
        <h1>{title}</h1>
      </div>
      <button type="button" class="btn sm quiet t-bar-back" onClick={back.go}>
        <Icon name="caret-left" size={16} />
        {back.label}
      </button>
    </TopBar>
  )
}
