/**
 * The drawer: the shell's frame, and whatever each module puts in it (design D3).
 *
 * Head (factotum, ✕), then the `Drawer` of every ENABLED module that declares one, in `nav.order`,
 * and at the foot every module with its `nav.icon` and `nav.label`, plus Device. A disabled module
 * stays at the foot, dimmed, with its reason. The shell knows none of them by name.
 *
 * Choosing anything REPLACES the drawer's history entry (design D4), so Back goes to where you
 * were, with the drawer closed. At ≥1024 px the drawer is always there; CSS decides, not this.
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
  /** Already in `nav.order`. Empty while the daemon is starting or unreachable: only Device then. */
  readonly modules: readonly ModuleSummary[]
  readonly screen: Screen
  readonly pending: readonly Pending[]
  readonly onClose: () => void
  readonly select: (path: string) => void
}

export function Drawer({ open, modules, screen, pending, onClose, select }: DrawerProps) {
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
          <span class="brand">factotum</span>
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
          <a href="/device" onClick={follow('/device')} aria-current={screen.kind === 'device' ? 'page' : undefined}>
            <Icon name="device-mobile" />
            Device
          </a>
        </nav>
      </aside>
    </>
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
