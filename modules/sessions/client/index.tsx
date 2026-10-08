/**
 * The sessions module's client: one session is the screen, and every other lives in the drawer
 * (spec 2026-09-18, design D5).
 *
 * WHAT `rest` MEANS. `''` picks the session that matters (a live pending, else the newest running,
 * else the newest, else a new one) and REPLACES the entry with it; `new` is the composer, and
 * `new/<siteId>` the composer with that project chosen; `projects` is the projects screen (spec
 * 2026-09-29, D10) and never a session id; anything else is a session id. The shell keeps `rest` in
 * step with the URL, so this never reads the address bar.
 *
 * THE LAUNCHER IS ONE HOST'S LAUNCH SCREEN (spec 2026-10-07-dos-hosts, design D12; criterion 12):
 * `/h/<host>/m/sessions/new` reads that host's setup through `api`, so its projects — all of them,
 * git or not —, its catalogue and its uploads. «Run on» does not send one host's choice to another:
 * it NAVIGATES to the other host's launch screen, carrying the project in the path, and the shell
 * mounts the screen again (it is keyed by host).
 *
 * THE LAST HOST CHOSEN on this device is remembered (`view.launchHost`, its own IndexedDB record), and
 * «New» with no host goes there once, on mount, while it is reachable. A launch the other host did
 * not answer is not retried: the composer says it may have started, and this reads that host again.
 *
 * PENDINGS OF EVERY HOST (criteria 10, 14): landing and the strip go to a pending's own host, and a
 * pending is over when ITS host's page says so. The screen's own `setup` and page load as before;
 * what is read from another host for that is asked APART, with `Promise.allSettled`, so a host that
 * is down leaves its pendings waiting and never turns this screen into "Could not load".
 *
 * A SESSION READS ITS OWN SUMMARY (`session.tsx`), so opening one does not depend on it being on the
 * first page of a list (criterion 36). The page here is only for landing on `''` and for noticing
 * that a pending's session is over; `GET sessions` leaves out what is archived and what belongs to a
 * missing project, so landing never lands on a conversation that answers 409.
 *
 * `api` arrives already prefixed to `/modules/sessions/`, and everything from outside is declared
 * STRUCTURALLY in `contract.ts`: a module depends on `packages/core` and only on core (CLAUDE.md
 * §1).
 *
 * NO CONSOLE (criterion 41): pendings and the query pass through here.
 */

import './client.css'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { EngineSetupView, SessionPage } from '../types.ts'
import { Strip, TopBar } from './bars.tsx'
import { LaunchComposer } from './composer.tsx'
import type { ViewProps } from './contract.ts'
import { SessionsDrawer } from './drawer.tsx'
import { messageOf } from './errors.ts'
import { hostKey, launchPath, launchRest, rememberedLaunchHost, runOnChoices, type RunOnChoice } from './hosts.ts'
import { Icon } from './icon.tsx'
import { ProjectsScreen } from './projects.tsx'
import { firstWithSession, hostOf, landingReady, otherHosts, pickRelevant, resolvedBy, type Pending } from './relevance.ts'
import { Session } from './session.tsx'
import { SkillsScreen } from './skills-screen.tsx'

const NEW = 'new'
const PROJECTS = 'projects'
const SKILLS = 'skills'

function SessionsView(view: ViewProps) {
  const { api, host, hosts, rest, navigate, pending, resolvePending } = view
  const [setup, setSetup] = useState<EngineSetupView | undefined>(undefined)
  const [page, setPage] = useState<SessionPage | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const launch = launchRest(rest)
  // The project chosen in the composer, for «Run on» to carry to the other host.
  const chosenSite = useRef<string | undefined>(undefined)
  const onSite = useCallback((siteId: string) => {
    chosenSite.current = siteId
  }, [])
  useRememberedLaunchHost(view, launch?.siteId, launch !== undefined)

  const refresh = useCallback(async () => {
    try {
      const [nextSetup, nextPage] = await Promise.all([
        api.get<EngineSetupView>('setup'),
        api.get<SessionPage>('sessions?page=0'),
      ])
      setSetup(nextSetup)
      setPage(nextPage)
      setError(undefined)
    } catch (cause: unknown) {
      setError(messageOf(cause))
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Entering "New session" reads the setup again: a project added, renamed or recoloured elsewhere
  // shows in the composer with its name and colour (criterion 26).
  const launching = launch !== undefined
  useEffect(() => {
    if (launching) void refresh()
  }, [launching, refresh])

  // A pending whose session this page shows as over is over (criterion 28 of the previous spec) —
  // only a pending of THIS screen's host: the others are checked on theirs, just below.
  useEffect(() => {
    if (page === undefined) return
    for (const tag of resolvedBy(pending, page.sessions, hosts, host)) resolvePending(tag)
  }, [page, pending, hosts, host, resolvePending])
  useOtherHostsResolve(view, page)

  // `/m/sessions` alone: land on what matters, without leaving the bare URL in the history.
  useEffect(() => {
    if (rest !== '' || page === undefined || !landingReady(pending, hosts)) return
    const pick = pickRelevant(pending, page.sessions, hosts, host)
    if (pick.kind === 'new') navigate(NEW, { replace: true })
    else navigate(pick.id, { replace: true, host: pick.host ?? null })
  }, [rest, page, pending, hosts, host, navigate])

  if (rest === PROJECTS) return <ProjectsScreen view={view} />
  // Before the last case below, where any other `rest` is a session id.
  if (rest === SKILLS) return <SkillsScreen view={view} />

  if (error !== undefined && (setup === undefined || page === undefined)) {
    return (
      <div class="s-screen">
        <TopBar title="Sessions" pendingTotal={view.pendingTotal} onMenu={view.openDrawer} />
        <div class="center-state">
          <Icon name="warning" size={32} />
          <h2>Could not load the sessions</h2>
          <p>{error}</p>
          <button type="button" class="btn" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (setup === undefined || page === undefined || rest === '') return <Loading view={view} />

  if (launch !== undefined) {
    // The first pending WITH A SESSION: a folder request has none, and must not hide an ask's strip.
    const other = firstWithSession(pending)
    // Remembered BEFORE going: the launch screen there, mounted anew, reads it.
    const runOn = (choice: RunOnChoice) =>
      // REPLACED, not pushed: Back must not land on the launcher just left, which would send it here again.
      void view.launchHost.write(choice.name).then(() => navigate(launchPath(chosenSite.current), { host: choice.key ?? null, replace: true }))
    return (
      <div class="s-screen">
        <TopBar title="New session" pendingTotal={view.pendingTotal} onMenu={view.openDrawer}>
          <RunOn view={view} onPick={runOn} />
        </TopBar>
        {other === undefined ? null : <Strip pending={other} onOpen={(id) => navigate(id, { host: hostOfPending(other, hosts) })} />}
        <div class="s-body">
          {page.sessions.length === 0 ? (
            <div class="center-state">
              <Icon name="terminal" size={32} />
              <h2>No sessions yet</h2>
              <p>Pick a project below and tell the agent what to do. It runs on your machine; you watch it here.</p>
            </div>
          ) : null}
        </div>
        <div class="s-dock">
          <LaunchComposer
            api={api}
            host={view.host}
            setup={setup}
            wantedSiteId={launch.siteId}
            onSite={onSite}
            onLaunched={(id) => {
              void refresh()
              navigate(id)
            }}
            onUnanswered={() => void refresh()}
            goTo={(id) => navigate(id)}
            onManage={() => navigate(PROJECTS)}
          />
        </div>
      </div>
    )
  }

  return <Session key={rest} view={view} id={rest} setup={setup} onChanged={() => void refresh()} />
}

/** Where a pending's session lives, as `navigate` takes it: `null` is the serving host. */
function hostOfPending(p: Pending, hosts: ViewProps['hosts']): string | null {
  return hostKey(hostOf(p), hosts) ?? null
}

/**
 * The pendings of the OTHER hosts are over when their own pages say so (criterion 14). Read whenever
 * this screen's page is — on mount, on entering New, after a launch — each host apart and all at
 * once with `Promise.allSettled`: one that fails or is down resolves nothing, and holds up nothing.
 */
function useOtherHostsResolve(view: ViewProps, page: SessionPage | undefined): void {
  const { apiOn, host, hosts, pending, resolvePending } = view
  const others = otherHosts(pending, hosts, host)
  const key = others.map((other) => other ?? '').join(',')
  useEffect(() => {
    if (page === undefined || others.length === 0) return undefined
    let live = true
    void Promise.allSettled(others.map((other) => apiOn(other).get<SessionPage>('sessions?page=0'))).then((results) => {
      if (!live) return
      results.forEach((result, i) => {
        if (result.status !== 'fulfilled') return
        for (const tag of resolvedBy(pending, result.value.sessions, hosts, others[i])) resolvePending(tag)
      })
    })
    return () => {
      live = false
    }
    // `key` stands for `others`; `pending` and `hosts` are read as they are when the page is.
  }, [page, key, apiOn, resolvePending])
}

/**
 * «New» on the serving host goes to the host last chosen on this device, if it is a reachable peer
 * (criterion 12). DECIDED ONCE EACH TIME the screen becomes the launcher, as soon as `GET /hosts` has
 * answered — never later, under someone already typing. Every other launch screen stays where it is.
 */
function useRememberedLaunchHost(view: ViewProps, siteId: string | undefined, launching: boolean): void {
  const { host, hosts, launchHost, navigate } = view
  const decided = useRef(false)
  const alive = useRef(true)
  // Read when the stored host arrives: the owner may have left the launcher while IndexedDB answered.
  const stillLaunching = useRef(launching)
  stillLaunching.current = launching
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  useEffect(() => {
    if (!launching) {
      decided.current = false
      return
    }
    if (decided.current || host !== undefined || hosts.length === 0) return
    decided.current = true
    void launchHost.read().then((saved) => {
      const target = rememberedLaunchHost(saved, hosts)
      if (alive.current && stillLaunching.current && target !== undefined) navigate(launchPath(siteId), { host: target, replace: true })
    })
  }, [launching, host, hosts, launchHost, navigate, siteId])
}

/**
 * «Run on»: the hosts this screen can be the launch screen of — the serving one and every reachable
 * peer (`runOnChoices`). Nothing with fewer than two, so a daemon without peers looks as it did.
 */
function RunOn({ view, onPick }: { readonly view: ViewProps; readonly onPick: (choice: RunOnChoice) => void }) {
  const choices = runOnChoices(view.hosts, view.host)
  if (choices.length === 0) return null
  return (
    <label class="chip s-pick s-run-on">
      <span class="s-run-on-label">Run on</span>
      <select
        aria-label="Run on"
        value={view.host ?? ''}
        onChange={(event) => {
          const value = (event.target as HTMLSelectElement).value
          const choice = choices.find((c) => (c.key ?? '') === value)
          if (choice !== undefined) onPick(choice)
        }}
      >
        {choices.map((choice) => (
          <option key={choice.key ?? ''} value={choice.key ?? ''}>
            {choice.name}
          </option>
        ))}
      </select>
      <Icon name="caret-down" size={12} />
    </label>
  )
}

function Loading({ view }: { readonly view: ViewProps }) {
  return (
    <div class="s-screen" aria-busy="true">
      <TopBar title="Sessions" pendingTotal={view.pendingTotal} onMenu={view.openDrawer} />
      {[0, 1, 2].map((n) => (
        <div class="skel" key={n}>
          <span class="dot" />
          <span class="lines">
            <span />
            <span />
          </span>
        </div>
      ))}
    </div>
  )
}

export const sessionsClient = {
  id: 'sessions',
  View: SessionsView,
  Drawer: SessionsDrawer,
  ownsTopBar: true,
  // In the shell's Settings (spec 2026-09-30): where projects are added, edited and deleted.
  settings: [
    {
      label: 'Projects',
      description: 'The folders agents may write in, shared folders, and the history of removed projects.',
      icon: 'folder-simple',
      rest: PROJECTS,
    },
    {
      label: 'Skills',
      description: 'What you can launch with /, and what you have used.',
      icon: 'lightning',
      rest: SKILLS,
    },
  ],
}
