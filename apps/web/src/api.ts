/**
 * Talking to the kernel, and to one module at a time.
 *
 * `moduleApi(id)` is prefixed so a module's screen cannot call another module's
 * routes without writing the whole path by hand — the client-side mirror of the
 * server rule that a module can only register under its own prefix.
 */

import type { NavEntry } from '@factotum/core'

export interface ModuleSummary {
  readonly id: string
  readonly nav?: NavEntry
  readonly status: { readonly kind: 'enabled' } | { readonly kind: 'disabled'; readonly reason: string }
}

export type ModulesResult =
  | { readonly state: 'ready'; readonly modules: readonly ModuleSummary[] }
  /** The daemon is up but boot has not finished. Worth retrying, unlike an error. */
  | { readonly state: 'starting' }
  | { readonly state: 'error'; readonly message: string }

export async function fetchModules(): Promise<ModulesResult> {
  try {
    const response = await fetch('/modules')
    if (response.status === 503) return { state: 'starting' }
    if (!response.ok) return { state: 'error', message: `the daemon answered ${response.status}` }
    const body = (await response.json()) as { modules: ModuleSummary[] }
    return { state: 'ready', modules: body.modules }
  } catch {
    return { state: 'error', message: 'could not reach the daemon' }
  }
}

export interface ModuleApi {
  get: <T>(path: string) => Promise<T>
  post: <T>(path: string, body?: unknown) => Promise<T>
}

export function moduleApi(id: string): ModuleApi {
  const base = `/modules/${id}/`

  const request = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await fetch(base + path.replace(/^\//, ''), {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    })
    const body = (await response.json()) as T & { error?: { message: string } }
    if (!response.ok) throw new Error(body.error?.message ?? `${response.status}`)
    return body
  }

  return {
    get: (path) => request(path, { method: 'GET' }),
    post: (path, body) =>
      request(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  }
}
