/**
 * The shell. Navigation, routing, and the three states that are not a module screen.
 *
 * IT KNOWS NO MODULE BY NAME. It asks the server which are running, looks each one up
 * in the client barrel, and renders what it finds. If the server declares one this
 * build of the client does not carry, it says so rather than showing a blank page —
 * which is exactly what happens when the daemon is newer than the page in a phone's
 * cache.
 */

import { useEffect, useState } from 'preact/hooks'
import { fetchModules, moduleApi, type ModuleSummary, type ModulesResult } from './api.ts'
import { clientFor } from './modules.ts'

const STARTING_RETRY_MS = 500

export function Shell() {
  const [result, setResult] = useState<ModulesResult>({ state: 'starting' })
  const [path, setPath] = useState(window.location.pathname)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      const next = await fetchModules()
      if (!live) return
      setResult(next)
      // Only "starting" is worth retrying: it is a state the daemon leaves on its own.
      if (next.state === 'starting') timer = setTimeout(() => void poll(), STARTING_RETRY_MS)
    }

    void poll()
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)

    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
      window.removeEventListener('popstate', onPop)
    }
  }, [])

  const go = (to: string) => (event: Event) => {
    event.preventDefault()
    window.history.pushState(null, '', to)
    setPath(to)
  }

  if (result.state === 'starting') {
    return <Notice title="Starting">factotum is still booting. This page will retry on its own.</Notice>
  }
  if (result.state === 'error') {
    return <Notice title="Not reachable">{result.message}</Notice>
  }

  const running = [...result.modules].sort(byOrder)
  const current = /^\/m\/([^/]+)/.exec(path)?.[1]

  return (
    <>
      <nav>
        <a href="/" onClick={go('/')} aria-current={current === undefined ? 'page' : undefined}>
          factotum
        </a>
        {running.map((module) => (
          <a
            key={module.id}
            href={`/m/${module.id}`}
            onClick={go(`/m/${module.id}`)}
            aria-current={current === module.id ? 'page' : undefined}
          >
            {module.nav?.label ?? module.id}
          </a>
        ))}
      </nav>
      <main>{current === undefined ? <Home modules={running} /> : <ModuleScreen id={current} modules={running} />}</main>
    </>
  )
}

function byOrder(a: ModuleSummary, b: ModuleSummary): number {
  const left = a.nav?.order ?? Number.MAX_SAFE_INTEGER
  const right = b.nav?.order ?? Number.MAX_SAFE_INTEGER
  return left === right ? a.id.localeCompare(b.id) : left - right
}

function Home({ modules }: { modules: readonly ModuleSummary[] }) {
  if (modules.length === 0) {
    return (
      <Notice title="No modules">
        Nothing is switched on. Enable one in <code>~/.factotum/&lt;env&gt;/config.json</code> under{' '}
        <code>modules</code>, then restart.
      </Notice>
    )
  }
  return (
    <>
      <h1>Modules</h1>
      <ul>
        {modules.map((module) => (
          <li key={module.id}>
            <a href={`/m/${module.id}`}>{module.nav?.label ?? module.id}</a>
            {module.status.kind === 'disabled' ? ` — disabled: ${module.status.reason}` : null}
          </li>
        ))}
      </ul>
    </>
  )
}

function ModuleScreen({ id, modules }: { id: string; modules: readonly ModuleSummary[] }) {
  const summary = modules.find((module) => module.id === id)

  if (summary === undefined) {
    return <Notice title="Not running">No module “{id}” is switched on.</Notice>
  }

  if (summary.status.kind === 'disabled') {
    return (
      <Notice title={`${summary.nav?.label ?? id} is disabled`}>
        <code>{summary.status.reason}</code>
        <p>Fix that in the config and restart factotum.</p>
      </Notice>
    )
  }

  const client = clientFor(id)
  if (client === undefined) {
    // The daemon is ahead of this page — the usual cause is a phone holding an older
    // build. Saying so beats a blank screen.
    return (
      <Notice title="Not in this build">
        The daemon is running “{id}”, but this copy of the client does not include its screen.
        Rebuild the client, or reload this page.
      </Notice>
    )
  }

  return <client.View api={moduleApi(id)} />
}

function Notice({ title, children }: { title: string; children: unknown }) {
  return (
    <main>
      <div class="notice">
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  )
}
