/**
 * The work-dir as a project of `sessions` (design D7; criterion 7). Only the screen reaches
 * `sessions`, so it lives here; the server only does what needs `realpath` (`site-match`).
 *
 * 1. `GET sessions/projects` → `POST mockups/:id/site-match` → a project that IS the work-dir or
 *    CONTAINS it → `POST mockups/:id/site { siteId }`. Repeated each time the mockup opens, so an
 *    approval made with the screen closed is picked up.
 * 2. Else, on the owner's tap: `POST sessions/projects { path, name }` and polling. A `409` or a request
 *    denied or expired → «Request again» with the reason; a `400` (it is, contains or is inside a
 *    project) → `POST mockups/:id/site { refused }`: no build project, the vault stages go on.
 */

import type { Mockup } from '../types.ts'
import type { Api } from './contract.ts'
import { messageOf, statusOf } from './launch.ts'

export type ProjectState =
  | { readonly kind: 'found'; readonly siteId: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'waiting'; readonly requestId: string }
  | { readonly kind: 'again'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'no-sessions' }
  | { readonly kind: 'error'; readonly reason: string }

export interface ProjectApis {
  readonly mockups: Api
  readonly sessions: Api | undefined
}

type Target = Pick<Mockup, 'id' | 'name' | 'workDir'>

const path = (m: Target, tail: string): string => `mockups/${encodeURIComponent(m.id)}/${tail}`

export async function reconcileProject(apis: ProjectApis, m: Target): Promise<ProjectState> {
  if (apis.sessions === undefined) return { kind: 'no-sessions' }
  try {
    const page = await apis.sessions.get<{ projects: readonly { id: string; path: string }[] }>('projects')
    const projects = page.projects.map((p) => ({ id: p.id, path: p.path }))
    const { siteId } = await apis.mockups.post<{ siteId: string | null }>(path(m, 'site-match'), { projects })
    if (siteId === null) return { kind: 'none' }
    await apis.mockups.post(path(m, 'site'), { siteId })
    return { kind: 'found', siteId }
  } catch (cause) {
    return { kind: 'error', reason: messageOf(cause) }
  }
}

export async function requestProject(apis: ProjectApis, m: Target): Promise<ProjectState> {
  if (apis.sessions === undefined) return { kind: 'no-sessions' }
  try {
    const { requestId } = await apis.sessions.post<{ requestId: string }>('projects', { path: m.workDir, name: m.name })
    return { kind: 'waiting', requestId }
  } catch (cause) {
    const reason = messageOf(cause)
    if (statusOf(cause) !== 400) return { kind: 'again', reason }
    await apis.mockups.post(path(m, 'site'), { refused: reason }).catch(() => undefined)
    return { kind: 'refused', reason }
  }
}

const ENDED: Readonly<Record<string, string>> = {
  denied: 'the request was denied',
  expired: 'the request expired after 10 minutes',
  rejected: 'the request was rejected',
}

export async function pollRequest(apis: ProjectApis, m: Target, requestId: string): Promise<ProjectState> {
  if (apis.sessions === undefined) return { kind: 'no-sessions' }
  let status: string
  try {
    status = (await apis.sessions.get<{ status: string }>(`projects/requests/${encodeURIComponent(requestId)}`)).status
  } catch (cause) {
    return { kind: 'again', reason: messageOf(cause) }
  }
  if (status === 'pending') return { kind: 'waiting', requestId }
  if (status === 'approved') return await reconcileProject(apis, m)
  return { kind: 'again', reason: ENDED[status] ?? `the request ended: ${status}` }
}
