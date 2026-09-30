/**
 * The drawer: the shell's frame, and whatever each module puts in it (design D3).
 *
 * Head (factotum, ✕), then the `Drawer` of every ENABLED module that declares one, in `nav.order`,
 * and at the foot every module with its `nav.icon` and `nav.label`, plus Settings. A disabled module
 * stays at the foot, dimmed, with its reason. The shell knows none of them by name.
 *
 * Choosing anything REPLACES the drawer's history entry (design D4), so Back goes to where you
 * were, with the drawer closed. At ≥1024 px the drawer is always there unless the owner folded it
 * away; CSS decides, from the shell's `data-rail`, not this.
 */

import { useEffect, useRef } from 'preact/hooks'
import type { ModuleSummary } from './api.ts'
import { Icon } from './icon.tsx'
import { navIcon } from './icons.ts'
import { apiFor, clientFor } from './modules.ts'
import { forModule, type Pending } from './pending.ts'
import { pathOf, type Screen } from './router.ts'

export interface DrawerProps {
  readonly open: boolean
  /** Already in `nav.order`. Empty while the daemon is starting or unreachable: only Settings then. */
  readonly modules: readonly ModuleSummary[]
  readonly screen: Screen
  readonly pending: readonly Pending[]
  readonly onClose: () => void
  /** Folds the always-there sidebar of a wide screen away. */
  readonly onFold: () => void
  readonly select: (path: string) => void
}

export function Drawer({ open, modules, screen, pending, onClose, onFold, select }: DrawerProps) {
  const close = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return undefined
    close.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const follow = (path: string) => (event: MouseEvent) => {
    event.preventDefault()
    select(path)
  }

  return (
    <>
      {open ? <div class="scrim drawer-scrim" onClick={onClose} /> : null}
      <aside class="drawer" data-open={open ? 'true' : 'false'} aria-label="Navigation">
        <div class="head">
          <span class="brand">
            <Mark />
            factotum
          </span>
          {/* Wide screens only (CSS): fold the sidebar away. On a phone it is ✕, which closes it. */}
          <button type="button" class="icon-btn fold" aria-label="Collapse sidebar" onClick={onFold}>
            <Icon name="sidebar-simple" />
          </button>
          <button type="button" ref={close} class="icon-btn close" aria-label="Close menu" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div class="sections">
          {modules.map((module) => (
            <ModuleSection key={module.id} module={module} screen={screen} pending={pending} select={select} />
          ))}
        </div>
        <nav class="foot" aria-label="Modules">
          {modules.map((module) => {
            const path = pathOf({ kind: 'module', id: module.id, rest: '' })
            const disabled = module.status.kind === 'disabled'
            return (
              <a
                key={module.id}
                href={path}
                onClick={follow(path)}
                aria-current={screen.kind === 'module' && screen.id === module.id ? 'page' : undefined}
                aria-disabled={disabled ? 'true' : undefined}
              >
                <Icon name={navIcon(module.nav?.icon)} />
                {module.nav?.label ?? module.id}
                {module.status.kind === 'disabled' ? <span class="aside">{module.status.reason}</span> : null}
              </a>
            )
          })}
          <a href="/settings" onClick={follow('/settings')} aria-current={screen.kind === 'settings' ? 'page' : undefined}>
            <Icon name="gear-six" />
            Settings
          </a>
        </nav>
      </aside>
    </>
  )
}

/** The app's icon, small: the prompt, `>_`, on the accent. Drawn, not an image, so it follows the tokens. */
function Mark() {
  return (
    <svg class="mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" />
      <path d="M10 10.5 15.5 16 10 21.5" />
      <rect class="cursor" x="17.5" y="19.5" width="6.5" height="2.6" rx="1.3" />
    </svg>
  )
}

function ModuleSection({
  module,
  screen,
  pending,
  select,
}: {
  readonly module: ModuleSummary
  readonly screen: Screen
  readonly pending: readonly Pending[]
  readonly select: (path: string) => void
}) {
  const client = clientFor(module.id)
  if (module.status.kind !== 'enabled' || client?.Drawer === undefined) return null
  const Section = client.Drawer
  const rest = screen.kind === 'module' && screen.id === module.id ? screen.rest : ''
  return (
    <Section
      api={apiFor(module.id)}
      rest={rest}
      navigate={(next) => select(pathOf({ kind: 'module', id: module.id, rest: next }))}
      pending={forModule(pending, module.id)}
    />
  )
}
