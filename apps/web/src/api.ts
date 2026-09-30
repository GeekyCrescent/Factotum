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
  /**
   * The raw bytes of ONE file, to one of this module's upload routes (spec 2026-10-01, D10). The name
   * and anything else travel in the query; the body is the file itself, never JSON.
   */
  upload: <T>(path: string, file: Blob, query: Readonly<Record<string, string>>) => Promise<T>
}

/**
 * What a response carries, WITHOUT ASSUMING IT IS JSON (spec 2026-10-01, D10).
 *
 * `response.json()` used to be called on everything. With the daemon down, `tailscale serve` answers
 * 502 in plain text, and that threw a `SyntaxError` with no status — so a screen could not tell "the
 * daemon is not there" from anything else. JSON is parsed only when it says it is JSON and has a body
 * (`send` in the kernel writes an empty body for `body: undefined`).
 *
 * THE BODY TRAVELS WITH THE ERROR. It used to be thrown away, which was fine while every failure was
 * just a message — and stops being fine the moment a server says "that site is busy, here is the
 * session that has it" and the screen has to be able to offer to go there.
 *
 * PROPERTIES ON AN ORDINARY `Error`, NOT AN EXPORTED CLASS, and that is the decision rather than the
 * shortcut. A class is a value at runtime, so reading it with `instanceof` would force a module's
 * screen to import from `apps/web/` — and CLAUDE.md §1 says a module depends on `packages/core` and
 * only on core. Read structurally instead, the way `modules/example/client.tsx` already declares the
 * api it is handed.
 */
export async function readResponse<T>(response: Response): Promise<T> {
  const type = response.headers.get('content-type') ?? ''
  const text = await response.text()
  let body: unknown
  if (type.includes('json') && text.trim() !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
  }
  if (!response.ok) {
    const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message
    throw Object.assign(new Error(typeof message === 'string' ? message : `${response.status}`), {
      status: response.status,
      body,
    })
  }
  return body as T
}

/** A request that never got an answer — no network, or a connection cut on a refusal. Status 0. */
function unreachable(cause: unknown): Error {
  return Object.assign(new Error(cause instanceof Error ? cause.message : 'could not reach the daemon'), { status: 0, body: undefined })
}

export function moduleApi(id: string): ModuleApi {
  const base = `/modules/${id}/`
  const url = (path: string): string => base + path.replace(/^\//, '')

  const send = async <T>(path: string, init: RequestInit): Promise<T> => {
    let response: Response
    try {
      response = await fetch(url(path), init)
    } catch (cause) {
      throw unreachable(cause)
    }
    return await readResponse<T>(response)
  }

  const json = (init: RequestInit): RequestInit => ({ ...init, headers: { 'content-type': 'application/json', ...init.headers } })

  return {
    get: (path) => send(path, json({ method: 'GET' })),
    // The body is ADDED, not set to `undefined`. With `exactOptionalPropertyTypes` a
    // `body: undefined` is not assignable to `RequestInit` — which had been a type error here
    // for as long as nothing type-checked `apps/web` (the root tsconfig does not reference it).
    post: (path, body) =>
      send(path, json(body === undefined ? { method: 'POST' } : { method: 'POST', body: JSON.stringify(body) })),
    // ONE MORE METHOD, and still only this module's own prefix: `base` is `/modules/<id>/` exactly as
    // for `get` and `post`, so no module gains a way to reach another module or the kernel. What is
    // new is the body — the file's bytes, with no JSON content type — not the way (spec 2026-10-01,
    // D10, which amends the note below that said this interface does not grow).
    upload: (path, file, query) => send(`${path}?${new URLSearchParams(query).toString()}`, { method: 'POST', body: file }),
  }
}

// ---------------------------------------------------------------------------
// Push: the daemon's own two routes, like `/modules` above — not a module's
// ---------------------------------------------------------------------------

/**
 * Two kernel-level calls, and `ModuleApi` does NOT grow for them: no module gains a new way to reach
 * the kernel. They exist because the subscription is the shell's, not any screen's (ADR-0008).
 * (`ModuleApi.upload` did grow it by one — to the module's own prefix; see above.)
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
