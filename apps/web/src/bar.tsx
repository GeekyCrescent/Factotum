/**
 * The shell's two building blocks for the pages it owns: the fallback bar and a centred state.
 *
 * THE FALLBACK BAR is what keeps the drawer reachable from every screen (criterion 15): Device,
 * the states, and any module that does not draw its own `.topbar`. It is ☰ and a title, nothing
 * more. A module that draws its own bar uses the same classes; it cannot import this file.
 */

import type { ComponentChildren } from 'preact'
import { Icon } from './icon.tsx'
import type { ShellIcon } from './icons.ts'

export function FallbackBar({
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

export function MenuButton({ pendingTotal, onMenu }: { readonly pendingTotal: number; readonly onMenu: () => void }) {
  return (
    <button
      type="button"
      class="icon-btn menu-button"
      aria-label={pendingTotal > 0 ? `Menu, ${pendingTotal} waiting for you` : 'Menu'}
      onClick={onMenu}
    >
      <Icon name="list" size={22} />
      {pendingTotal > 0 ? <span class="badge" aria-hidden="true">{pendingTotal}</span> : null}
    </button>
  )
}

export function CenterState({
  icon,
  title,
  children,
}: {
  readonly icon: ShellIcon
  readonly title: string
  readonly children?: ComponentChildren
}) {
  return (
    <div class="center-state">
      <Icon name={icon} size={32} />
      <h2>{title}</h2>
      {children}
    </div>
  )
}
