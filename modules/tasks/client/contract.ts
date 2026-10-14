/**
 * What the shell hands this module, declared HERE, structurally (spec 2026-10-14, design D9) — as
 * `modules/inbox/client/contract.ts` does. Nothing is imported from `apps/web` or from another
 * module: the shell's props and these meet where `modules.ts` puts `tasksClient` in its list, and the
 * typecheck there is the link.
 *
 * THE EDGE TO ANOTHER MODULE (design D9; ADR-0021) is `peerModule` and `openModule`, never an import of
 * its folder (criterion 44). Every `host` here speaks the CLIENT's language — `undefined` is the host
 * serving the app — and `where.ts` translates it to and from what the board stores.
 */

import type { Api as DictationApi } from '../../shared/dictation/contract.ts'

/** Another module's api: this module's two members, and `upload`, which the shared dictation needs. */
export type PeerApi = Api & DictationApi

export interface Api {
  readonly get: <T>(path: string) => Promise<T>
  readonly post: <T>(path: string, body?: unknown) => Promise<T>
}

export interface NavigateOptions {
  readonly replace?: boolean
  /** A name goes to that host, `null` to the serving one; without the key, this screen's host. */
  readonly host?: string | null
}

export interface HostView {
  readonly name: string
  readonly self: boolean
  readonly reachable: boolean
}

export interface ViewProps {
  readonly api: Api
  /** The host this screen is on, from `/h/<host>/`; `undefined` for the one serving the app. */
  readonly host: string | undefined
  /** Every host, the serving one first; empty until `GET /hosts` first answers. */
  readonly hosts: readonly HostView[]
  /** What follows `/m/tasks/`: `''`, `cycles`, `cycles/<id>`, or a card id. */
  readonly rest: string
  readonly navigate: (rest: string, options?: NavigateOptions) => void
  /** Another module's api on a host; `undefined` when the serving server does not run that module. */
  readonly peerModule: (id: string, host: string | undefined) => PeerApi | undefined
  /** Another module's screen: `/m/<id>/<rest>`, or on another host. */
  readonly openModule: (id: string, rest: string, options?: NavigateOptions) => void
  /** The module draws its own bar (`ownsTopBar`), so its ☰ opens the shell's drawer through this. */
  readonly openDrawer: () => void
  /** Everything pending across the app: the count on the ☰. */
  readonly pendingTotal: number
}
