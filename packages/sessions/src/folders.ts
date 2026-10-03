/**
 * Adding, changing and removing projects and shared folders (spec 2026-09-29, D3, D4). Kept apart
 * from `engine.ts`, which runs sessions.
 *
 * WIDENING NEEDS THE OWNER'S PHONE; NARROWING DOES NOT (guardrails 2, 4). A new project or shared
 * folder is a REQUEST: checked, then an approval pushed to a device, and written only when the owner
 * answers from there — checked AGAIN, inside the registry's queue, against the registry as it is by
 * then (criterion 15). A process on this machine can call every route here (requirements §0.5); what
 * it does not have is the token, which travels only in memory and in the encrypted push.
 *
 * Renaming, recolouring, ordering, categorising, removing a shared folder and deleting a project need
 * no approval: they only narrow, or change nothing an agent can use.
 */

import { basename, dirname } from 'node:path'
import type { Logger, NotificationMessage, Notifier, Timers } from '@factotum/core'
import type { History } from './history.ts'
import type { SessionIndex } from './index-cache.ts'
import type { SiteLocks } from './locks.ts'
import { MAX_PENDING_GRANTS, type GrantRequest, type GrantTable } from './permissions/grants.ts'
import type { SiteTable } from './projects.ts'
import { checkCandidate, type CandidateWorld, type DiskProbe } from './sites.ts'
import type { RemoveOutcome, SessionStore } from './store.ts'
import type {
  AnswerGrantResult,
  GrantInspect,
  GrantOutcome,
  GrantStatus,
  ProjectChange,
  ProjectLayout,
  ProjectPatch,
  ProjectRequest,
  RegistryStore,
  RequestResult,
} from './types.ts'

export interface FoldersDeps {
  readonly registry: RegistryStore
  readonly table: SiteTable
  readonly grants: GrantTable
  readonly index: SessionIndex
  readonly history: History
  readonly store: SessionStore
  readonly locks: SiteLocks
  readonly notify: Notifier
  readonly log: Logger
  readonly timers: Timers
  readonly now: () => Date
  readonly home: string
  readonly factotumRoot: string
  readonly installRoot: string | undefined
  readonly caseInsensitive: boolean
  readonly disk: DiskProbe | undefined
  readonly candidateTimeoutMs: number | undefined
  readonly liveCount: () => number
  readonly isLive: (id: string) => boolean
  /** Deletes one conversation and the uploads its owner sent in it (spec 2026-10-01, D6). */
  readonly removeConversation: (id: string) => Promise<RemoveOutcome>
  /** What a lock holds while its project is deleted (`engine.ts`). */
  readonly removing: string
}

export interface Folders {
  readonly requestProject: (request: ProjectRequest) => Promise<RequestResult>
  readonly requestShared: (path: string) => Promise<RequestResult>
  readonly requestStatus: (requestId: string) => Promise<GrantStatus>
  readonly inspectGrant: (token: string) => Promise<GrantInspect>
  readonly answerGrant: (token: string, decision: 'allow' | 'deny') => Promise<AnswerGrantResult>
  readonly updateProject: (id: string, patch: ProjectPatch) => Promise<ProjectChange>
  readonly setLayout: (layout: ProjectLayout) => Promise<ProjectChange>
  readonly removeProject: (id: string) => Promise<ProjectChange>
  readonly removeHistory: (siteId: string) => Promise<ProjectChange>
  readonly removeShared: (path: string) => Promise<ProjectChange>
}

const NO_DEVICE =
  'no device can be reached to approve this: subscribe one in Device, or add it by hand with the daemon stopped (`factotum site add` says how)'

export function createFolders(deps: FoldersDeps): Folders {
  const { registry, table, grants } = deps

  const world = (projects: readonly { readonly id: string; readonly path: string }[], shared: readonly string[]): CandidateWorld => ({
    home: deps.home,
    factotumRoot: deps.factotumRoot,
    installRoot: deps.installRoot,
    projects,
    shared,
    timers: deps.timers,
    caseInsensitive: deps.caseInsensitive,
    ...(deps.disk === undefined ? {} : { disk: deps.disk }),
    ...(deps.candidateTimeoutMs === undefined ? {} : { timeoutMs: deps.candidateTimeoutMs }),
  })

  /** Fire and forget, like every notice: a slow push service is not the caller's to wait for. */
  const send = (message: NotificationMessage): void => {
    void Promise.resolve()
      .then(() => deps.notify.send(message))
      .catch((error: unknown) => deps.log.warn(`a folder notice could not be sent: ${error instanceof Error ? error.name : 'error'}`))
  }

  /**
   * The checks that come BEFORE the disk, in the order of design D3: a broken registry, an index not
   * built yet, too many waiting, nobody to ask. Each is a 409 and none of them pushes anything.
   */
  const gate = async (): Promise<RequestResult | undefined> => {
    const broken = table.broken()
    if (broken !== undefined) return { outcome: 'conflict', conflict: 'broken', reason: `the projects registry is broken: ${broken}` }
    if (!deps.index.ready) return { outcome: 'conflict', conflict: 'starting', reason: 'factotum is still starting; try again in a moment' }
    if (grants.pendingCount() >= MAX_PENDING_GRANTS) return { outcome: 'conflict', conflict: 'too-many', reason: 'too many pending requests' }
    if (!deps.notify.canReach()) return { outcome: 'conflict', conflict: 'no-device', reason: NO_DEVICE }
    return undefined
  }

  /** The id is the module's rule: validated if typed, derived from the RESOLVED folder if not. */
  const idFor = async (request: ProjectRequest, base: string): Promise<{ id: string } | { refused: string }> => {
    const id = request.id ?? registry.deriveId(base)
    if (id === undefined) return { refused: `could not work out an id from "${base}": pick one` }
    if (!registry.isValidId(id)) return { refused: `"${id}" is not a valid project id` }
    if (table.entry(id) !== undefined) return { refused: `the id "${id}" is already a project` }
    const orphans = await deps.history.removed()
    if (orphans.some((removed) => removed.siteId === id)) {
      return { refused: `the id "${id}" has old conversations of a removed project; its old history is still there: delete it first, or pick another id` }
    }
    return { id }
  }

  const open = (request: GrantRequest): RequestResult => {
    const opened = grants.open(request)
    // THE ORDER IS THE DESIGN, as for an ask: open BEFORE the notice, or an owner quick enough would
    // answer a token that does not exist yet. The body names the folder, never its path.
    send({
      title: 'approval',
      // The folder's name AND its parent's: a name alone is the caller's to choose (`/tmp/x/Documents`),
      // and the parent is what tells the owner which one it is. Never the whole path.
      body: `${request.kind === 'project' ? 'Add project' : 'Share folder'} · ${request.base} (in ${basename(dirname(request.path)) || '/'})`,
      tag: `grant:${opened.requestId}`,
      path: `/m/sessions/projects?grant=${opened.token}`,
      data: { kind: 'grant', grantId: opened.token, requestId: opened.requestId, name: request.base },
      until: opened.expiresAt,
    })
    return { outcome: 'requested', requestId: opened.requestId, expiresAt: opened.expiresAt }
  }

  /**
   * The write an approval triggers, IN THE REGISTRY'S QUEUE: the disk is checked again against the
   * registry as it is now — which includes an approval that landed a moment before this one — with
   * the same 5 s ceiling (criterion 15). The resolved path must not have moved since the request.
   */
  const apply = (request: GrantRequest, requestId: string) => async (): Promise<GrantOutcome> => {
    const result = await registry.update(async (current) => {
      const candidate = await checkCandidate(request.path, request.kind, world(current.projects, current.shared.map((s) => s.path)))
      if (!candidate.ok) return { refused: candidate.reason }
      if (candidate.realPath !== request.path) return { refused: `${request.path} resolves somewhere else now (${candidate.realPath})` }
      if (request.kind === 'shared') {
        if (deps.liveCount() > 0) return { refused: 'a session is running; shared folders change only with none' }
        return { kind: 'add-shared', path: request.path }
      }
      if (current.projects.some((p) => p.id === request.id)) return { refused: `the id "${request.id}" is already a project` }
      const orphans = await deps.history.removed()
      if (orphans.some((removed) => removed.siteId === request.id)) return { refused: `the id "${request.id}" has old history` }
      return { kind: 'add-project', id: request.id, path: request.path, name: request.name, color: request.color }
    })
    if (result.kind !== 'ok') {
      // WITHOUT THE REASON: a reason about the disk can carry a path, and a notice leaves the tailnet
      // (guardrail 6). The reason is on the screen, through `requestStatus`.
      send({ title: 'not added', body: `Could not add · ${request.base}`, tag: `added:${requestId}`, path: '/m/sessions/projects' })
      return { outcome: 'rejected', reason: result.reason }
    }
    try {
      await table.apply(result.registry, request.kind === 'shared')
    } catch (error) {
      // It IS on disk: the approval stands, and the next start loads it. Said, not swallowed.
      deps.log.warn(`added ${request.base} to the registry but could not check it yet: ${error instanceof Error ? error.message : String(error)}`)
    }
    send({
      title: 'added',
      body: `Added · ${request.kind === 'project' ? (request.name ?? request.id) : request.base}`,
      tag: `added:${requestId}`,
      path: '/m/sessions/projects',
    })
    return { outcome: 'approved', reason: undefined }
  }

  const change = (reason: string): ProjectChange => ({ outcome: 'conflict', reason })

  return {
    requestProject: async (request) => {
      const refused = await gate()
      if (refused !== undefined) return refused
      const projects = table.registryView().projects
      const candidate = await checkCandidate(request.path, 'project', world(projects, table.registryView().shared.map((s) => s.path)))
      if (!candidate.ok) return { outcome: 'invalid', reason: candidate.reason }
      if (grants.waitingFor(candidate.realPath)) {
        return { outcome: 'conflict', conflict: 'already-waiting', reason: 'a request for that folder is already waiting for your approval' }
      }
      const id = await idFor(request, candidate.base)
      if ('refused' in id) return { outcome: 'invalid', reason: id.refused }
      return open({ kind: 'project', path: candidate.realPath, id: id.id, name: request.name, color: request.color, base: candidate.base })
    },

    requestShared: async (path) => {
      const refused = await gate()
      if (refused !== undefined) return refused
      const view = table.registryView()
      const candidate = await checkCandidate(path, 'shared', world(view.projects, view.shared.map((s) => s.path)))
      if (!candidate.ok) return { outcome: 'invalid', reason: candidate.reason }
      if (grants.waitingFor(candidate.realPath)) {
        return { outcome: 'conflict', conflict: 'already-waiting', reason: 'a request for that folder is already waiting for your approval' }
      }
      if (deps.liveCount() > 0) {
        return { outcome: 'conflict', conflict: 'live-sessions', reason: 'a session is running; shared folders change only with none' }
      }
      return open({ kind: 'shared', path: candidate.realPath, base: candidate.base })
    },

    requestStatus: async (requestId) => grants.status(requestId),

    inspectGrant: async (token) => {
      const found = grants.get(token)
      if (found === undefined) return { kind: 'unknown' }
      if (found === 'settled') return { kind: 'settled' }
      const request =
        found.kind === 'project'
          ? { kind: 'project' as const, path: found.path, id: found.id, name: found.name, color: found.color }
          : { kind: 'shared' as const, path: found.path }
      return { kind: 'pending', request, expiresAt: found.expiresAt }
    },

    answerGrant: async (token, decision) => {
      const found = grants.get(token)
      // Settled or unknown: the table answers from what it remembers, and `apply` is never run.
      if (found === undefined || found === 'settled') return await grants.answer(token, decision, async () => ({ outcome: 'rejected', reason: 'settled' }))
      const { expiresAt: _expiresAt, requestId, ...request } = found
      return await grants.answer(token, decision, apply(request, requestId))
    },

    updateProject: async (id, patch) => {
      // Looked up BEFORE anything else (criterion 11): an unknown id is a 404, whatever the body.
      if (table.entry(id) === undefined) return { outcome: 'unknown' }
      const result = await registry.update(async (current) =>
        current.projects.some((p) => p.id === id)
          ? { kind: 'set-project', id, name: patch.name, color: patch.color, concurrent: patch.concurrent }
          : { refused: `no project "${id}"` },
      )
      if (result.kind !== 'ok') return change(result.reason)
      await table.apply(result.registry, false)
      return { outcome: 'ok', removedSessions: 0 }
    },

    /**
     * The owner's order and categories, WHOLE. Checked inside the queue against the projects there
     * are then: a layout read before a project was added or removed would drop it or name one that
     * is gone, so it is refused and the screen reloads. The module checked its shape already.
     */
    setLayout: async (layout) => {
      const result = await registry.update(async (current) => {
        const ids = new Set(layout.order.map((placed) => placed.id))
        const fits = ids.size === layout.order.length && ids.size === current.projects.length && current.projects.every((p) => ids.has(p.id))
        return fits ? { kind: 'set-layout', layout } : { refused: 'the projects changed since this screen read them; reload and try again' }
      })
      if (result.kind !== 'ok') return change(result.reason)
      await table.apply(result.registry, false)
      return { outcome: 'ok', removedSessions: 0 }
    },

    /**
     * Deleting a project deletes its HISTORY, never its folder (guardrail 7). The site's lock is held
     * as `removing` for the whole of it, so a launch in that moment is refused "being removed"
     * (criterion 27), and let go in a `finally`. Looked up before the lock (criterion 11).
     */
    removeProject: async (id) => {
      if (table.entry(id) === undefined) return { outcome: 'unknown' }
      // EXCLUSIVE, always: it loses to any session, one or N (spec 2026-10-03, criterion 16).
      const acquired = await deps.locks.acquire(id, deps.removing, deps.now().toISOString(), () => 'exclusive')
      if (!acquired.ok) {
        return change(acquired.heldBy === undefined ? `project "${id}" is locked and the lock cannot be read` : 'a session is running in that project')
      }
      try {
        const result = await registry.update(async (current) =>
          current.projects.some((p) => p.id === id) ? { kind: 'remove-project', id } : { refused: `no project "${id}"` },
        )
        if (result.kind !== 'ok') return change(result.reason)
        await table.apply(result.registry, false)
        let removedSessions = 0
        for (const meta of deps.index.bySite(id)) {
          if ((await deps.removeConversation(meta.id)) === 'removed') removedSessions += 1
        }
        return { outcome: 'ok', removedSessions }
      } finally {
        await deps.locks.release(id, deps.removing)
      }
    },

    removeHistory: async (siteId) => {
      if (table.broken() !== undefined) return change('the projects registry is broken, so nothing counts as removed')
      if (table.entry(siteId) !== undefined) return { outcome: 'unknown' }
      const metas = deps.index.bySite(siteId)
      if (metas.length === 0) return { outcome: 'unknown' }
      let removedSessions = 0
      for (const meta of metas) {
        if ((await deps.removeConversation(meta.id)) === 'removed') removedSessions += 1
      }
      return { outcome: 'ok', removedSessions }
    },

    removeShared: async (path) => {
      if (!table.registryView().shared.some((s) => s.path === path)) return { outcome: 'unknown' }
      if (deps.liveCount() > 0) return change('a session is running; shared folders change only with none')
      const result = await registry.update(async (current) =>
        current.shared.some((s) => s.path === path) ? { kind: 'remove-shared', path } : { refused: `${path} is not shared` },
      )
      if (result.kind !== 'ok') return change(result.reason)
      await table.apply(result.registry, true)
      deps.log.info(`stopped sharing ${basename(path)}`)
      return { outcome: 'ok', removedSessions: 0 }
    },
  }
}
