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
    if (!response.ok) {
      // THE BODY TRAVELS WITH THE ERROR. It used to be thrown away, which was fine
      // while every failure was just a message — and stops being fine the moment a
      // server says "that site is busy, here is the session that has it" and the
      // screen has to be able to offer to go there.
      //
      // PROPERTIES ON AN ORDINARY `Error`, NOT AN EXPORTED CLASS, and that is the
      // decision rather than the shortcut. A class is a value at runtime, so reading
      // it with `instanceof` would force a module's screen to import from `apps/web/`
      // — and CLAUDE.md §1 says a module depends on `packages/core` and only on core.
      // Read structurally instead, the way `modules/example/client.tsx` already
      // declares the api it is handed.
      //
      // This does not grow `ModuleApi`: it still has `get` and `post`, and no module
      // gains a new way to talk to the kernel. What changes is that an error stops
      // discarding what the server sent to explain it — which is a fix for every
      // module, not a favour to one.
      throw Object.assign(new Error(body.error?.message ?? `${response.status}`), {
        status: response.status,
        body,
      })
    }
    return body
  }

  return {
    get: (path) => request(path, { method: 'GET' }),
    post: (path, body) =>
      request(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  }
}
