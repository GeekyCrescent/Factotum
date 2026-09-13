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

export interface ModuleViewProps {
  readonly api: ModuleApi
}

export interface ModuleClient {
  readonly id: string
  readonly View: ComponentType<ModuleViewProps>
}

export const CLIENTS: readonly ModuleClient[] = [exampleClient]

export function clientFor(id: string): ModuleClient | undefined {
  return CLIENTS.find((client) => client.id === id)
}
