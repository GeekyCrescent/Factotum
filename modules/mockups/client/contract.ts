/**
 * What the shell hands this module, declared HERE, structurally — as `modules/tasks/client/contract.ts`
 * does. Nothing is imported from `apps/web` or from another module: the shell's props and these meet
 * where `apps/web/src/modules.ts` puts `mockupsClient` in its list.
 *
 * THE EDGE TO `sessions` is `peerModule('sessions', host)`, never an import of its folder
 * (criterion 43). `host` is the host serving THIS module: stages launch there (D5).
 */

import type { Api as DictationApi } from '../../shared/dictation/contract.ts'

export interface Api {
  readonly get: <T>(path: string) => Promise<T>
  readonly post: <T>(path: string, body?: unknown) => Promise<T>
}

/** This module's own api: the two members, and `upload` for the inputs and the dictation. */
export type ModuleApi = Api & DictationApi

export interface NavigateOptions {
  readonly replace?: boolean
  readonly host?: string | null
}

export interface ViewProps {
  readonly api: ModuleApi
  /** The host this screen is on; `undefined` for the one serving the app. */
  readonly host: string | undefined
  /** What follows `/m/mockups/`: `''`, `new`, `<id>` or `<id>/<stage>`. */
  readonly rest: string
  readonly navigate: (rest: string, options?: NavigateOptions) => void
  readonly peerModule: (id: string, host: string | undefined) => (Api & DictationApi) | undefined
  readonly openModule: (id: string, rest: string, options?: NavigateOptions) => void
  readonly openDrawer: () => void
  readonly pendingTotal: number
}
