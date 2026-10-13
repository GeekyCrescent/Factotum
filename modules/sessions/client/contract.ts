/**
 * What the shell hands this module, declared HERE, structurally (spec 2026-09-18, design D3).
 *
 * A module imports nothing from `apps/web` (CLAUDE.md §1, criterion 9): the shell's
 * `ModuleViewProps` and these meet only where `modules.ts` puts `sessionsClient` in the barrel, and
 * the typecheck there is the link. Types only; no DOM (guardrail 11). `Blob` below is not the DOM
 * library's: it is the web-standard global that `@types/node` declares too, so `modules/` still
 * type-checks without `lib: ["dom"]` (spec 2026-10-01, D10).
 */

import type { Pending } from './relevance.ts'

export interface Api {
  readonly get: <T>(path: string) => Promise<T>
  readonly post: <T>(path: string, body?: unknown) => Promise<T>
  /** The raw bytes of one file to one of this module's upload routes, the name in the query. */
  readonly upload: <T>(path: string, file: Blob, query: Readonly<Record<string, string>>) => Promise<T>
  /** The address of one of this module's routes on the api's host, for an `<img>` or a download. */
  readonly url: (path: string) => string
}

/**
 * How the shell names hosts to this module (spec 2026-10-07-dos-hosts, design D12): in `apiOn` and a
 * screen's `host`, `undefined` is the host serving the app; in `navigate`, `null` goes back to it and
 * no `host` key stays where it is. A name from `hosts` turns into those through `hostKey` (`hosts.ts`).
 */
export interface NavigateOptions {
  readonly replace?: boolean
  readonly host?: string | null
}

/** One host as `GET /hosts` gives it. `lastSeenAt` is `null` for this host and a peer never seen. */
export interface HostView {
  readonly name: string
  readonly self: boolean
  readonly reachable: boolean
  readonly lastSeenAt: string | null
}

/**
 * The host this device last chose to launch on, kept by the shell in its own IndexedDB record
 * (`launch`, never `device`: design D12). `read` gives the name AS STORED; which one is the serving
 * host, and whether it is up, the launcher decides (`rememberedLaunchHost`). Neither ever throws.
 */
export interface LaunchHostStore {
  readonly read: () => Promise<string | undefined>
  readonly write: (name: string) => Promise<void>
}

export interface ViewProps {
  /** This module on the screen's host: everything the screen does goes there. */
  readonly api: Api
  /** The screen's host, from `/h/<host>/`; `undefined` for the serving one. */
  readonly host: string | undefined
  /** This module on any host, only for what crosses hosts: the strip, the landing, grants. */
  readonly apiOn: (host: string | undefined) => Api
  /** Every host, the serving one first; empty until `GET /hosts` first answers. */
  readonly hosts: readonly HostView[]
  readonly launchHost: LaunchHostStore
  readonly rest: string
  readonly search: string
  readonly navigate: (rest: string, options?: NavigateOptions) => void
  readonly openDrawer: () => void
  readonly overlay: string | undefined
  readonly setOverlay: (name: string | undefined) => void
  readonly pending: readonly Pending[]
  readonly pendingTotal: number
  readonly resolvePending: (tag: string) => void
}

export interface DrawerProps {
  readonly api: Api
  /** Always `undefined`: the drawer belongs to the whole app. */
  readonly host: string | undefined
  readonly apiOn: (host: string | undefined) => Api
  readonly hosts: readonly HostView[]
  readonly rest: string
  /** Without the `host` key, to the serving host. */
  readonly navigate: (rest: string, options?: { readonly host?: string | null }) => void
  readonly pending: readonly Pending[]
}
