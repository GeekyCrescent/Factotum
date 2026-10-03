/**
 * `/m/sessions/projects`: the projects and the shared folders, with their state; adding one, which
 * asks for approval on the phone; editing a name and a colour; deleting a project by typing its
 * name; and the history of projects that are no longer registered (spec 2026-09-29, D10).
 *
 * THE LIST FIRST (redesign, 2026-09-30): adding is a button that opens a dialog, a row opens its
 * editor, and `⋯` (or a right-click) opens its menu. What deletes sits at the bottom of the editor.
 *
 * A REQUEST IS FOLLOWED HERE until it ends: every 2 s, `GET projects/requests/:id`, for the ones
 * made on this screen AND for every folder-request pending this device holds. One that is no longer
 * `pending` resolves its pending (criterion 22), so the ☰ count does not keep something already
 * answered on another device.
 *
 * NO CONSOLE (criterion 41): tokens pass through here.
 */

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import type { Color, GrantStatus, ProjectsPage, ProjectView } from '../types.ts'
import { TopBar } from './bars.tsx'
import type { ViewProps } from './contract.ts'
import { messageOf } from './errors.ts'
import { GrantPanel, useGrant, type GrantTarget } from './grant-panel.tsx'
import { grantTokenFrom } from '../grant-token.ts'
import { Icon } from './icon.tsx'
import { ContextMenu, type MenuAt } from './context-menu.tsx'
import { shortPath } from './format.ts'
import { AddFolderDialog, ConfirmSheet, DeleteProjectSheet, EditProjectDialog, NewProjectDialog, type NewProject } from './project-forms.tsx'
import { grantOf } from './relevance.ts'
import { toneClass } from './tone.ts'

const POLL_MS = 2_000

interface Requested {
  readonly requestId: string
  readonly label: string
}

interface Outcome {
  readonly requestId: string
  readonly message: string
  readonly ok: boolean
}

type Open =
  | { readonly kind: 'new' }
  | { readonly kind: 'folder' }
  | { readonly kind: 'unshare'; readonly path: string }
  | { readonly kind: 'edit'; readonly project: ProjectView }
  | { readonly kind: 'delete'; readonly project: ProjectView }
  | { readonly kind: 'history'; readonly siteId: string; readonly count: number }
  | { readonly kind: 'grant'; readonly target: GrantTarget }

function outcomeOf(label: string, status: GrantStatus): Outcome['message'] {
  switch (status.status) {
    case 'approved':
      return `Added ${label}.`
    case 'denied':
      return `${label} was denied on the phone. Nothing was added.`
    case 'expired':
      return `The request for ${label} expired before anyone answered.`
    case 'rejected':
      return `Could not add ${label}: ${status.reason ?? 'no reason given'}`
    default:
      return `The request for ${label} is no longer waiting.`
  }
}

export function ProjectsScreen({ view }: { readonly view: ViewProps }) {
  const { api, pending, resolvePending } = view
  const [page, setPage] = useState<ProjectsPage | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [requested, setRequested] = useState<readonly Requested[]>([])
  const [outcomes, setOutcomes] = useState<readonly Outcome[]>([])
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Open | undefined>(undefined)
  const [menu, setMenu] = useState<{ readonly at: MenuAt; readonly items: readonly MenuChoice[] } | undefined>(undefined)
  const [showRemoved, setShowRemoved] = useState(false)
  const [sheetError, setSheetError] = useState<string | undefined>(undefined)
  // The `?grant=` the page was opened with: read ONCE, the shell already took it out of the URL.
  const [token] = useState(() => grantTokenFrom(view.search))

  const refresh = useCallback(async () => {
    try {
      setPage(await api.get<ProjectsPage>('projects'))
      setLoadError(undefined)
    } catch (cause: unknown) {
      setLoadError(messageOf(cause))
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (token !== undefined) setOpen({ kind: 'grant', target: { token, tag: undefined, name: undefined } })
  }, [token])

  const grants = useMemo(() => pending.flatMap((p) => grantOf(p) ?? []), [pending])
  const followed = useMemo(() => {
    const ids = new Map<string, string>()
    for (const r of requested) ids.set(r.requestId, r.label)
    for (const g of grants) if (!ids.has(g.requestId)) ids.set(g.requestId, g.name ?? 'the folder')
    return ids
  }, [requested, grants])
  const followedKey = [...followed.keys()].sort().join(',')

  // Every request still followed, now and every POLL_MS: those that ended leave, with what happened.
  useEffect(() => {
    if (followed.size === 0) return undefined
    let live = true
    const check = async () => {
      for (const [requestId, label] of followed) {
        let status: GrantStatus
        try {
          status = await api.get<GrantStatus>(`projects/requests/${requestId}`)
        } catch (cause: unknown) {
          if ((cause as { status?: number }).status !== 404) continue
          status = { status: 'unknown' }
        }
        if (!live || status.status === 'pending') continue
        resolvePending(`grant:${requestId}`)
        setRequested((current) => current.filter((r) => r.requestId !== requestId))
        setOutcomes((current) => [...current.filter((o) => o.requestId !== requestId), { requestId, message: outcomeOf(label, status), ok: status.status === 'approved' }])
        if (status.status === 'approved') void refresh()
      }
    }
    void check()
    const timer = setInterval(() => void check(), POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
    // `followedKey` stands for `followed`: the same ids must not restart the poll on every render.
  }, [api, followedKey, resolvePending, refresh])

  /** A request from a dialog. Throws, so the dialog shows why; closes it when it went through. */
  const ask = async (path: 'projects' | 'shared', body: unknown, label: string) => {
    const result = await api.post<{ requestId: string }>(path, body)
    setRequested((current) => [...current, { requestId: result.requestId, label }])
    setOpen(undefined)
  }

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setSheetError(undefined)
    try {
      await work()
      setOpen(undefined)
      await refresh()
    } catch (cause: unknown) {
      setSheetError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const close = useCallback(() => {
    setOpen(undefined)
    setSheetError(undefined)
  }, [])

  const home = page?.home ?? ''
  const blocked = page?.registryError !== undefined
  const projectMenu = (project: ProjectView, at: MenuAt) =>
    setMenu({
      at,
      items: [
        { icon: 'pencil-simple', label: 'Edit', danger: false, choose: () => setOpen({ kind: 'edit', project }) },
        { icon: 'trash', label: 'Delete', danger: true, choose: () => setOpen({ kind: 'delete', project }) },
      ],
    })
  const sharedMenu = (path: string, at: MenuAt) =>
    setMenu({ at, items: [{ icon: 'x', label: 'Stop sharing', danger: true, choose: () => setOpen({ kind: 'unshare', path }) }] })

  return (
    <div class="s-screen">
      {/* The bar says where this lives, Settings; the page says what it is. */}
      <TopBar title="Settings" pendingTotal={view.pendingTotal} onMenu={view.openDrawer} />
      <div class="s-body s-projects">
        <header class="s-page-head">
          <div>
            <h1>Projects</h1>
            <p>Where agents may write: your projects and the folders they share.</p>
          </div>
          <button type="button" class="btn primary" disabled={page === undefined || blocked} onClick={() => setOpen({ kind: 'new' })}>
            <Icon name="plus" size={16} />
            New project
          </button>
        </header>

        {loadError !== undefined && page === undefined ? (
          <div class="notice err" role="alert">
            <div class="head">
              <Icon name="warning" size={16} />
              {loadError}
            </div>
          </div>
        ) : null}
        {page?.registryError === undefined ? null : (
          <div class="notice err" role="alert">
            <div class="head">
              <Icon name="warning" size={16} />
              The projects registry is broken, so no project is loaded.
            </div>
            <p class="mono s-detail">{page.registryError}</p>
            <p class="dim-2">Fix {page.file} by hand with the daemon stopped, then start it again.</p>
          </div>
        )}
        {page === undefined || page.skipped.length === 0 ? null : (
          <div class="notice" role="status">
            <div class="head">
              <Icon name="warning" size={16} />
              {page.skipped.length === 1 ? 'One entry' : `${page.skipped.length} entries`} in the registry could not be read and {page.skipped.length === 1 ? 'was' : 'were'} skipped.
            </div>
            {page.skipped.map((s) => (
              <p key={`${s.list}${s.index}`} class="mono s-detail">
                {s.list}[{s.index}]: {s.reason}
              </p>
            ))}
            <p class="dim-2">They stay in {page.file} as they are.</p>
          </div>
        )}
        {outcomes.map((outcome) => (
          <div key={outcome.requestId} class={outcome.ok ? 'notice' : 'notice err'} role="status">
            <div class="head">
              <Icon name={outcome.ok ? 'check-circle' : 'warning'} size={16} />
              {outcome.message}
            </div>
            <div class="acts">
              <button type="button" class="btn quiet sm" onClick={() => setOutcomes((current) => current.filter((o) => o !== outcome))}>
                Dismiss
              </button>
            </div>
          </div>
        ))}
        {[...followed].map(([requestId, label]) => {
          const held = grants.find((g) => g.requestId === requestId)
          return (
            <div key={requestId} class="notice ask" role="status">
              <div class="head">
                <Icon name="hand" size={16} />
                Waiting for approval: {label}
              </div>
              {held?.grantId === undefined ? (
                <p class="dim-2">Approve it on your phone.</p>
              ) : (
                <div class="acts">
                  <button type="button" class="btn" onClick={() => setOpen({ kind: 'grant', target: { token: held.grantId, tag: held.tag, name: held.name } })}>
                    Review
                  </button>
                </div>
              )}
            </div>
          )
        })}

        <section class="s-section">
          <h2 class="s-section-title">Projects</h2>
          {page === undefined ? <p class="dim-3">Loading…</p> : null}
          {page !== undefined && page.projects.length === 0 && !blocked ? (
            <p class="s-empty">No projects yet. An agent has nowhere it may write until you add one.</p>
          ) : null}
          {page === undefined || page.projects.length === 0 ? null : (
            <div class="s-cards">
              {page.projects.map((project) => (
                <FolderRow
                  key={project.id}
                  tone={toneClass(project.id, project.color)}
                  title={project.name ?? project.id}
                  path={shortPath(project.path, home)}
                  fullPath={project.path}
                  sub={
                    project.status === 'missing'
                      ? undefined
                      : `${project.total} conversation${project.total === 1 ? '' : 's'}${project.archived === 0 ? '' : ` · ${project.archived} archived`}`
                  }
                  badge={project.status === 'missing' ? { text: 'Folder missing', warn: true } : undefined}
                  onOpen={() => setOpen({ kind: 'edit', project })}
                  onMenu={(at) => projectMenu(project, at)}
                />
              ))}
            </div>
          )}
        </section>

        <section class="s-section">
          <div class="s-section-head">
            <div>
              <h2 class="s-section-title">Shared folders</h2>
              <p>Every project may write here, and nothing locks them. They change only while no session runs.</p>
            </div>
            <button type="button" class="btn" disabled={page === undefined || blocked} onClick={() => setOpen({ kind: 'folder' })}>
              <Icon name="plus" size={16} />
              Add folder
            </button>
          </div>
          {page === undefined || page.shared.length === 0 ? null : (
            <div class="s-cards">
              {page.shared.map((shared) => (
                <FolderRow
                  key={shared.path}
                  tone=""
                  title={shared.path.split('/').filter(Boolean).pop() ?? shared.path}
                  path={shortPath(shared.path, home)}
                  fullPath={shared.path}
                  sub={undefined}
                  badge={shared.status === 'missing' ? { text: 'Folder missing', warn: true } : { text: 'Read & write', warn: false }}
                  onOpen={undefined}
                  onMenu={(at) => sharedMenu(shared.path, at)}
                />
              ))}
            </div>
          )}
        </section>

        {page === undefined || page.removed.length === 0 ? null : (
          <section class="s-section">
            <button type="button" class="s-disclose s-section-title" aria-expanded={showRemoved} onClick={() => setShowRemoved(!showRemoved)}>
              <Icon name={showRemoved ? 'caret-down' : 'caret-right'} size={14} />
              Removed projects ({page.removed.length})
            </button>
            {showRemoved ? (
              <>
                <p class="dim-3 s-hint">Conversations whose project is no longer registered. They are not in the drawer or the search.</p>
                <div class="s-cards">
                  {page.removed.map((removed) => (
                    <div key={removed.siteId} class="s-card">
                      <span class="s-card-icon s-card-muted">
                        <Icon name="stack" size={20} />
                      </span>
                      <span class="s-card-text">
                        <b class="mono">{removed.siteId}</b>
                        <small class="num">
                          {removed.count} conversation{removed.count === 1 ? '' : 's'}
                        </small>
                      </span>
                      <button type="button" class="btn quiet sm s-danger" onClick={() => setOpen({ kind: 'history', siteId: removed.siteId, count: removed.count })}>
                        Delete history
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </section>
        )}
      </div>

      {menu === undefined ? null : (
        <ContextMenu at={menu.at} onClose={() => setMenu(undefined)}>
          {menu.items.map((item) => (
            <button type="button" key={item.label} role="menuitem" class={item.danger ? 's-ctx-item s-danger' : 's-ctx-item'} onClick={item.choose}>
              <Icon name={item.icon} size={16} />
              {item.label}
            </button>
          ))}
        </ContextMenu>
      )}
      {open?.kind === 'new' && page !== undefined ? (
        <NewProjectDialog
          canRequest={page.canRequest}
          file={page.file}
          onClose={close}
          onCreate={(p: NewProject) => ask('projects', p, p.name ?? p.id ?? p.path.split('/').filter(Boolean).pop() ?? p.path)}
        />
      ) : null}
      {open?.kind === 'folder' && page !== undefined ? (
        <AddFolderDialog canRequest={page.canRequest} file={page.file} onClose={close} onAdd={(path) => ask('shared', { path }, path.split('/').filter(Boolean).pop() ?? path)} />
      ) : null}
      {open?.kind === 'edit' ? (
        <EditProjectDialog
          id={open.project.id}
          name={open.project.name}
          color={open.project.color}
          concurrent={open.project.concurrent}
          onClose={close}
          onDelete={() => setOpen({ kind: 'delete', project: open.project })}
          onSave={async (name: string | undefined, color: Color | undefined, concurrent: boolean) => {
            await api.post(`projects/${open.project.id}`, { name: name ?? '', color, concurrent })
            setOpen(undefined)
            await refresh()
          }}
        />
      ) : null}
      {open?.kind === 'delete' ? (
        <DeleteProjectSheet
          label={open.project.name ?? open.project.id}
          total={open.project.total + open.project.archived}
          busy={busy}
          error={sheetError}
          onClose={close}
          onDelete={() => void act(() => api.post(`projects/${open.project.id}/remove`))}
        />
      ) : null}
      {open?.kind === 'unshare' ? (
        <ConfirmSheet
          title="Stop sharing this folder?"
          body={`Agents will no longer write in ${shortPath(open.path, home)}. The folder and its files are not touched.`}
          action="Stop sharing"
          busy={busy}
          error={sheetError}
          onClose={close}
          onConfirm={() => void act(() => api.post('shared/remove', { path: open.path }))}
        />
      ) : null}
      {open?.kind === 'history' ? (
        <ConfirmSheet
          title={`Delete the history of ${open.siteId}?`}
          body={`Its ${open.count === 1 ? 'conversation is' : `${open.count} conversations are`} deleted for good.`}
          action="Delete history"
          busy={busy}
          error={sheetError}
          onClose={close}
          onConfirm={() => void act(() => api.post(`projects/removed/${open.siteId}/remove`))}
        />
      ) : null}
      {open?.kind === 'grant' ? <GrantSheet view={view} target={open.target} onClose={close} onOver={refresh} /> : null}
    </div>
  )
}

interface MenuChoice {
  readonly icon: 'pencil-simple' | 'trash' | 'x'
  readonly label: string
  readonly danger: boolean
  readonly choose: () => void
}

/**
 * One folder as a card: its icon on its colour, its name, its path as `~/…`, a line under it, a
 * badge, then `⋯` and — when the card opens something — a chevron. A right-click opens the menu too.
 */
function FolderRow({
  tone,
  title,
  path,
  fullPath,
  sub,
  badge,
  onOpen,
  onMenu,
}: {
  readonly tone: string
  readonly title: string
  readonly path: string
  readonly fullPath: string
  readonly sub: string | undefined
  readonly badge: { readonly text: string; readonly warn: boolean } | undefined
  readonly onOpen: (() => void) | undefined
  readonly onMenu: (at: MenuAt) => void
}) {
  const openMenu = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    onMenu(event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : { x: box.left, y: box.bottom + 4 })
  }
  const main = (
    <>
      <span class="s-card-icon">
        <Icon name="folder-simple" size={20} />
      </span>
      <span class="s-card-text">
        <b>{title}</b>
        <small class="mono" title={fullPath}>
          {path}
        </small>
        {sub === undefined ? null : <small class="num">{sub}</small>}
      </span>
    </>
  )
  return (
    <div class={`s-card ${tone}`} onContextMenu={openMenu}>
      {/* The card's main part is ONE button, stretched over the card: no control inside another. */}
      {onOpen === undefined ? (
        <span class="s-card-main">{main}</span>
      ) : (
        <button type="button" class="s-card-main s-card-open" onClick={onOpen}>
          {main}
        </button>
      )}
      {badge === undefined ? null : <span class={badge.warn ? 's-badge-pill s-badge-warn' : 's-badge-pill'}>{badge.text}</span>}
      <button type="button" class="icon-btn s-card-more" aria-label={`Options for ${title}`} onClick={openMenu}>
        <Icon name="dots-three" size={18} />
      </button>
      {onOpen === undefined ? null : (
        <span class="s-card-chevron" aria-hidden="true">
          <Icon name="caret-right" size={14} />
        </span>
      )}
    </div>
  )
}

/** The approval, kept apart so its hook lives exactly as long as the sheet. */
function GrantSheet({ view, target, onClose, onOver }: { readonly view: ViewProps; readonly target: GrantTarget; readonly onClose: () => void; readonly onOver: () => Promise<void> }) {
  const { resolvePending } = view
  const over = useCallback(
    (tag: string | undefined) => {
      if (tag !== undefined) resolvePending(tag)
      void onOver()
    },
    [resolvePending, onOver],
  )
  const { state, answer } = useGrant(view.api, target, over)
  return <GrantPanel target={target} state={state} answer={answer} onClose={onClose} />
}
