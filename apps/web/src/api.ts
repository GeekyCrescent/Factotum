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
    // The body is ADDED, not set to `undefined`. With `exactOptionalPropertyTypes` a
    // `body: undefined` is not assignable to `RequestInit` — which had been a type error here
    // for as long as nothing type-checked `apps/web` (the root tsconfig does not reference it).
    post: (path, body) =>
      request(path, body === undefined ? { method: 'POST' } : { method: 'POST', body: JSON.stringify(body) }),
  }
}

// ---------------------------------------------------------------------------
// Push: the daemon's own two routes, like `/modules` above — not a module's
// ---------------------------------------------------------------------------

/**
 * Two kernel-level calls, and `ModuleApi` does NOT grow: no module gains a new way to reach the
 * kernel. They exist because the subscription is the shell's, not any screen's (ADR-0008).
 */
export async function fetchPushPublicKey(): Promise<
  { readonly ok: true; readonly publicKey: string } | { readonly ok: false; readonly message: string }
> {
  try {
    const response = await fetch('/push/public-key')
    const body = (await response.json()) as { publicKey?: string; error?: { message: string } }
    if (response.ok && typeof body.publicKey === 'string') return { ok: true, publicKey: body.publicKey }
    return { ok: false, message: body.error?.message ?? `the daemon answered ${response.status}` }
  } catch {
    return { ok: false, message: 'could not reach the daemon' }
  }
}

export async function postPushSubscription(
  subscription: unknown,
): Promise<
  | { readonly ok: true; readonly count: number; readonly sameMachine?: boolean }
  | { readonly ok: false; readonly status: number; readonly message: string }
> {
  try {
    const response = await fetch('/push/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(subscription),
    })
    const body = (await response.json()) as { count?: number; sameMachine?: unknown; error?: { message: string } }
    if (response.ok && typeof body.count === 'number') {
      // Only a boolean counts. A daemon from before this field existed says nothing, and
      // "nothing" stays unknown — which the worker treats as the safe case (design D12).
      return typeof body.sameMachine === 'boolean'
        ? { ok: true, count: body.count, sameMachine: body.sameMachine }
        : { ok: true, count: body.count }
    }
    // The daemon's message travels as-is: for a full cap it names `factotum push reset`.
    return { ok: false, status: response.status, message: body.error?.message ?? `the daemon answered ${response.status}` }
  } catch {
    return { ok: false, status: 0, message: 'could not reach the daemon' }
  }
}
