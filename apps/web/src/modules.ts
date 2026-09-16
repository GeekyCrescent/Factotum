/**
 * The client half of every bundled module.
 *
 * Static imports, because a bundler cannot bundle what it cannot see in the import
 * graph. The consequence is accepted and measured later if it matters: the bundle
 * carries the code of modules that are switched off. What the shell will not do is
 * RENDER one the server has not declared — enabled is a server fact.
 */

import type { ComponentType } from 'preact'
import type { ModuleApi } from './api.ts'
import { exampleClient } from '../../../modules/example/client.tsx'
import { sessionsClient } from '../../../modules/sessions/client.tsx'

export interface ModuleViewProps {
  readonly api: ModuleApi
  /**
   * What followed `/m/<id>/` in the path, `''` at the module's root. So a notification can land
   * IN the session it is about rather than on the list.
   *
   * This is NOT the open client edge of ADR-0005 — "a screen calling another module" — and does
   * not touch it: it tells a screen where it was opened from.
   */
  readonly rest: string
  /**
   * `window.location.search` as it was (`''` or `'?…'`). A SEPARATE field because the shell
   * keeps `pathname`, which has no query: a token in `?ask=` could never have reached `rest`.
   */
  readonly search: string
}

export interface ModuleClient {
  readonly id: string
  readonly View: ComponentType<ModuleViewProps>
}

export const CLIENTS: readonly ModuleClient[] = [exampleClient, sessionsClient]

export function clientFor(id: string): ModuleClient | undefined {
  return CLIENTS.find((client) => client.id === id)
}
