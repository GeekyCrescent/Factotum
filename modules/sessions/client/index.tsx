/**
 * The sessions module's client: one session is the screen, and every other lives in the drawer
 * (spec 2026-09-18, design D5).
 *
 * WHAT `rest` MEANS. `''` picks the session that matters (a live pending, else the newest running,
 * else the newest, else a new one) and REPLACES the entry with it; `new` is the composer; `projects`
 * is the projects screen (spec 2026-09-29, D10) and never a session id; anything else is a session
 * id. The shell keeps `rest` in step with the URL, so this never reads the address bar.
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
import { useCallback, useEffect, useState } from 'preact/hooks'
import type { EngineSetupView, SessionPage } from '../types.ts'
import { Strip, TopBar } from './bars.tsx'
import { LaunchComposer } from './composer.tsx'
import type { ViewProps } from './contract.ts'
import { SessionsDrawer } from './drawer.tsx'
import { messageOf } from './errors.ts'
import { Icon } from './icon.tsx'
import { ProjectsScreen } from './projects.tsx'
import { firstWithSession, pickRelevant, resolvedBy } from './relevance.ts'
import { Session } from './session.tsx'
import { SkillsScreen } from './skills-screen.tsx'

const NEW = 'new'
const PROJECTS = 'projects'
const SKILLS = 'skills'

function SessionsView(view: ViewProps) {
  const { api, rest, navigate, pending, resolvePending } = view
  const [setup, setSetup] = useState<EngineSetupView | undefined>(undefined)
  const [page, setPage] = useState<SessionPage | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

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
  useEffect(() => {
    if (rest === NEW) void refresh()
  }, [rest, refresh])

  // A pending whose session this page shows as over is over (criterion 28 of the previous spec).
  useEffect(() => {
    if (page === undefined) return
    for (const tag of resolvedBy(pending, page.sessions)) resolvePending(tag)
  }, [page, pending, resolvePending])

  // `/m/sessions` alone: land on what matters, without leaving the bare URL in the history.
  useEffect(() => {
    if (rest !== '' || page === undefined) return
    const pick = pickRelevant(pending, page.sessions)
    navigate(pick.kind === 'new' ? NEW : pick.id, { replace: true })
  }, [rest, page, pending, navigate])

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

  if (rest === NEW) {
    // The first pending WITH A SESSION: a folder request has none, and must not hide an ask's strip.
    const other = firstWithSession(pending)
    return (
      <div class="s-screen">
        <TopBar title="New session" pendingTotal={view.pendingTotal} onMenu={view.openDrawer} />
        {other === undefined ? null : <Strip pending={other} onOpen={(id) => navigate(id)} />}
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
            setup={setup}
            onLaunched={(id) => {
              void refresh()
              navigate(id)
            }}
            goTo={(id) => navigate(id)}
            onManage={() => navigate(PROJECTS)}
          />
        </div>
      </div>
    )
  }

  return <Session key={rest} view={view} id={rest} setup={setup} onChanged={() => void refresh()} />
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
