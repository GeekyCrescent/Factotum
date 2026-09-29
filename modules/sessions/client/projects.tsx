/**
 * `/m/sessions/projects`: the projects and the shared folders, with their state; adding one, which
 * asks for approval on the phone; editing a name and a colour; deleting a project by typing its
 * name; and the history of projects that are no longer registered (spec 2026-09-29, D10).
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
import { AddProjectForm, AddSharedForm, ConfirmSheet, DeleteProjectSheet, EditProjectSheet, type NewProject } from './project-forms.tsx'
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
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState<Open | undefined>(undefined)
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

  const ask = async (path: 'projects' | 'shared', body: unknown, label: string) => {
    setBusy(true)
    setFormError(undefined)
    try {
      const result = await api.post<{ requestId: string }>(path, body)
      setRequested((current) => [...current, { requestId: result.requestId, label }])
    } catch (cause: unknown) {
      setFormError(messageOf(cause))
    } finally {
      setBusy(false)
    }
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

  return (
    <div class="s-screen">
      <TopBar title="Projects" pendingTotal={view.pendingTotal} onMenu={view.openDrawer} />
      <div class="s-body s-projects">
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
              {page.skipped.length === 1 ? 'One entry' : `${page.skipped.length} entries`} in {page.file} could not be read and {page.skipped.length === 1 ? 'was' : 'were'} skipped.
            </div>
            {page.skipped.map((s) => (
              <p key={`${s.list}${s.index}`} class="mono s-detail">
                {s.list}[{s.index}]: {s.reason}
              </p>
            ))}
            <p class="dim-2">They stay in the file as they are.</p>
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
          <h2 class="s-sect">Projects</h2>
          {page === undefined ? <p class="dim-3">Loading…</p> : null}
          {page !== undefined && page.projects.length === 0 && page.registryError === undefined ? (
            <p class="dim-2">No projects yet. An agent has nowhere it may write until you add one.</p>
          ) : null}
          {page?.projects.map((project) => (
            <div key={project.id} class={`s-prow ${toneClass(project.id, project.color)}`}>
              <span class="s-prow-dot" aria-hidden="true" />
              <div class="s-prow-text">
                <b>{project.name ?? project.id}</b>
                <small class="mono">
                  {project.name === undefined ? '' : `${project.id} · `}
                  {project.path}
                </small>
                {project.status === 'missing' ? (
                  <small class="s-missing">
                    <Icon name="warning" size={12} />
                    Folder missing. Its conversations are not read until it is back.
                  </small>
                ) : (
                  <small class="dim-3 num">
                    {project.total} conversation{project.total === 1 ? '' : 's'}
                    {project.archived === 0 ? '' : ` · ${project.archived} archived`}
                  </small>
                )}
              </div>
              <button type="button" class="icon-btn" aria-label={`Edit ${project.name ?? project.id}`} onClick={() => setOpen({ kind: 'edit', project })}>
                <Icon name="pencil-simple" size={18} />
              </button>
              <button type="button" class="btn quiet sm" onClick={() => setOpen({ kind: 'delete', project })}>
                Delete
              </button>
            </div>
          ))}
        </section>

        <section class="s-section">
          <h2 class="s-sect">Add a project</h2>
          {page === undefined || page.canRequest ? null : (
            <div class="notice" role="status">
              <div class="head">
                <Icon name="warning" size={16} />
                No device can approve a request right now.
              </div>
              <p class="dim-2">
                Subscribe your phone in Device. Without one: stop the daemon, add an entry to <span class="mono">{page.file}</span>, and start it
                again.
              </p>
            </div>
          )}
          {formError === undefined ? null : (
            <div class="notice err" role="alert">
              <div class="head">
                <Icon name="warning" size={16} />
                {formError}
              </div>
            </div>
          )}
          <AddProjectForm
            busy={busy || page?.registryError !== undefined}
            onSubmit={(p: NewProject) => void ask('projects', p, p.name ?? p.id ?? p.path.split('/').filter(Boolean).pop() ?? p.path)}
          />
        </section>

        <section class="s-section">
          <h2 class="s-sect">Shared folders</h2>
          <p class="dim-3 s-hint">Writable from every project, and nothing locks them. They change only while no session runs.</p>
          {page?.shared.map((shared) => (
            <div key={shared.path} class="s-prow">
              <Icon name="folder-simple" size={18} />
              <div class="s-prow-text">
                <small class="mono">{shared.path}</small>
                {shared.status === 'missing' ? <small class="s-missing">Folder missing</small> : null}
              </div>
              <button type="button" class="btn quiet sm" disabled={busy} onClick={() => void act(() => api.post('shared/remove', { path: shared.path }))}>
                Stop sharing
              </button>
            </div>
          ))}
          <AddSharedForm busy={busy || page?.registryError !== undefined} onSubmit={(path) => void ask('shared', { path }, path.split('/').filter(Boolean).pop() ?? path)} />
        </section>

        {page === undefined || page.removed.length === 0 ? null : (
          <section class="s-section">
            <h2 class="s-sect">Removed projects</h2>
            <p class="dim-3 s-hint">Conversations whose project is no longer registered. They are not in the drawer or the search.</p>
            {page.removed.map((removed) => (
              <div key={removed.siteId} class="s-prow">
                <Icon name="stack" size={18} />
                <div class="s-prow-text">
                  <b class="mono">{removed.siteId}</b>
                  <small class="dim-3 num">
                    {removed.count} conversation{removed.count === 1 ? '' : 's'}
                  </small>
                </div>
                <button type="button" class="btn quiet sm" onClick={() => setOpen({ kind: 'history', siteId: removed.siteId, count: removed.count })}>
                  Delete history
                </button>
              </div>
            ))}
          </section>
        )}
      </div>

      {open?.kind === 'edit' ? (
        <EditProjectSheet
          id={open.project.id}
          name={open.project.name}
          color={open.project.color}
          busy={busy}
          error={sheetError}
          onClose={close}
          onSave={(name: string | undefined, color: Color | undefined) => void act(() => api.post(`projects/${open.project.id}`, { name: name ?? '', color }))}
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
