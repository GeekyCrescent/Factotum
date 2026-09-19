/**
 * The shell: the frame, the drawer, routing, what is pending, and the pages that are not a module.
 *
 * IT KNOWS NO MODULE BY NAME. It asks the server which are running, looks each one up in the client
 * barrel, and renders what it finds. `/` lands on the first enabled one by `nav.order`. If the
 * server declares one this build of the client does not carry, it says so rather than showing a
 * blank page, which is exactly what happens when the daemon is newer than the page in a phone's
 * cache.
 *
 * EVERY SCREEN HAS A ☰ (criterion 15): a module that draws its own bar gets `openDrawer`; for every
 * other screen the shell draws the fallback bar.
 */

import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import { fetchModules, type ModuleSummary, type ModulesResult } from './api.ts'
import { CenterState, FallbackBar } from './bar.tsx'
import { Device, PUSH_API, rememberPush } from './device.tsx'
import { Drawer } from './drawer.tsx'
import type { ShellIcon } from './icons.ts'
import { apiFor, clientFor } from './modules.ts'
import { landing, ordered } from './nav.ts'
import { forModule } from './pending.ts'
import { resubscribe, type EnableResult } from './push.ts'
import { pathOf, type Screen } from './router.ts'
import { usePending, type Pendings } from './use-pending.ts'
import { useRoute, type Route } from './use-route.ts'

const STARTING_RETRY_MS = 500
const DRAWER = 'drawer'

export function Shell({ initialSearch }: { readonly initialSearch: string }) {
  const route = useRoute(initialSearch)
  const pendings = usePending()
  const { result, retry } = useModules()
  const push = usePushAtStart()

  const modules = result.state === 'ready' ? ordered(result.modules) : []
  const target = route.screen.kind === 'root' ? landing(modules)?.id : undefined
  const { land, openOverlay, closeOverlay } = route

  useEffect(() => {
    if (target !== undefined) land(pathOf({ kind: 'module', id: target, rest: '' }))
  }, [target, land])

  const openDrawer = useCallback(() => openOverlay(DRAWER), [openOverlay])
  const bar = (title: string) => <FallbackBar title={title} pendingTotal={pendings.all.length} onMenu={openDrawer} />

  return (
    <div class="app">
      <Drawer
        open={route.overlay === DRAWER}
        modules={modules}
        screen={route.screen}
        pending={pendings.all}
        onClose={closeOverlay}
        select={route.go}
      />
      <main class="content">
        {result.state === 'starting' ? (
          <Page bar={bar('factotum')} icon="arrow-clockwise" title="Starting">
            <p>factotum is still booting. This page will retry on its own.</p>
          </Page>
        ) : result.state === 'error' ? (
          <Page bar={bar('factotum')} icon="plugs" title="Not reachable">
            <p>{result.message}</p>
            <button type="button" class="btn" onClick={retry}>
              Try again
            </button>
          </Page>
        ) : route.screen.kind === 'device' ? (
          <Device push={push.result} onPush={push.set} pendingTotal={pendings.all.length} openDrawer={openDrawer} />
        ) : (
          <Screens screen={route.screen} modules={modules} route={route} pendings={pendings} bar={bar} openDrawer={openDrawer} />
        )}
      </main>
    </div>
  )
}

function Screens({
  screen,
  modules,
  route,
  pendings,
  bar,
  openDrawer,
}: {
  readonly screen: Exclude<Screen, { kind: 'device' }>
  readonly modules: readonly ModuleSummary[]
  readonly route: Route
  readonly pendings: Pendings
  readonly bar: (title: string) => ComponentChildren
  readonly openDrawer: () => void
}) {
  if (screen.kind === 'root') {
    // With a module to land on, the shell's effect replaces this entry right after this render.
    if (landing(modules) !== undefined) return null
    return (
      <Page bar={bar('factotum')} icon="plugs" title="No modules">
        <p>
          Nothing is switched on. Enable one in <code class="mono">~/.factotum/&lt;env&gt;/config.json</code> under{' '}
          <code class="mono">modules</code>, then restart.
        </p>
      </Page>
    )
  }
  if (screen.kind === 'unknown') {
    return (
      <Page bar={bar('factotum')} icon="circle" title="Nothing here">
        <p>
          There is no page at <span class="mono">{screen.path}</span>.
        </p>
      </Page>
    )
  }

  const summary = modules.find((module) => module.id === screen.id)
  if (summary === undefined) {
    return (
      <Page bar={bar('factotum')} icon="plugs" title="Not running">
        <p>No module “{screen.id}” is switched on.</p>
      </Page>
    )
  }
  const label = summary.nav?.label ?? summary.id
  if (summary.status.kind === 'disabled') {
    return (
      <Page bar={bar(label)} icon="plugs" title={`${label} is disabled`}>
        <p>
          <code class="mono">{summary.status.reason}</code>
        </p>
        <p>Fix that in the config and restart factotum.</p>
      </Page>
    )
  }

  const client = clientFor(screen.id)
  if (client === undefined) {
    // The daemon is ahead of this page: the usual cause is a phone holding an older build.
    return (
      <Page bar={bar(label)} icon="arrow-clockwise" title="Not in this build">
        <p>
          The daemon is running “{screen.id}”, but this copy of the client does not include its screen. Rebuild the client,
          or reload this page.
        </p>
      </Page>
    )
  }

  const id = screen.id
  const view = (
    <client.View
      api={apiFor(id)}
      rest={screen.rest}
      search={route.search}
      navigate={(rest, options) => route.go(pathOf({ kind: 'module', id, rest }), options)}
      openDrawer={openDrawer}
      overlay={route.overlay === DRAWER ? undefined : route.overlay}
      setOverlay={(name) => (name === undefined ? route.closeOverlay() : route.openOverlay(name))}
      pending={forModule(pendings.all, id)}
      pendingTotal={pendings.all.length}
      resolvePending={(tag) => pendings.resolve(id, tag)}
    />
  )
  if (client.ownsTopBar === true) return view
  // A module under the fallback bar draws no frame of its own: the shell gives it the page margin.
  return (
    <>
      {bar(label)}
      <div class="module-body">{view}</div>
    </>
  )
}

function Page({
  bar,
  icon,
  title,
  children,
}: {
  readonly bar: ComponentChildren
  readonly icon: ShellIcon
  readonly title: string
  readonly children: ComponentChildren
}) {
  return (
    <>
      {bar}
      <CenterState icon={icon} title={title}>
        {children}
      </CenterState>
    </>
  )
}

/** `/modules`, retried while the daemon is starting: a state it leaves on its own, unlike an error. */
function useModules(): { readonly result: ModulesResult; readonly retry: () => void } {
  const [result, setResult] = useState<ModulesResult>({ state: 'starting' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const next = await fetchModules()
      if (!live) return
      setResult(next)
      if (next.state === 'starting') timer = setTimeout(() => void poll(), STARTING_RETRY_MS)
    }
    void poll()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [attempt])

  const retry = useCallback(() => {
    setResult({ state: 'starting' })
    setAttempt((n) => n + 1)
  }, [])
  return { result, retry }
}

/**
 * The silent re-post at start (design D12): only when notifications were already on, never a
 * prompt. It tells the worker whether this is the daemon's machine before the first push, and
 * gives Device its count without a tap.
 */
function usePushAtStart(): { readonly result: EnableResult | undefined; readonly set: (result: EnableResult) => void } {
  const [result, setResult] = useState<EnableResult | undefined>(undefined)
  const set = useCallback((next: EnableResult) => {
    rememberPush(next)
    setResult(next)
  }, [])

  useEffect(() => {
    void resubscribe(PUSH_API).then((next) => {
      if (next !== undefined) set(next)
    })
  }, [set])

  return { result, set }
}
