/**
 * Everything the engine needs for background services, wired at once (spec 2026-10-02-servicios-en-segundo-plano,
 * D10), so `engine.ts` calls ONE factory and not six: it is already over the house's 800 lines, and this spec
 * may add at most 60 to it (criterion 42).
 *
 * Resolved here: the shell (D3), the registry stamped with this process (D6), `liveSite` from what the engine
 * knows (a site id, only while the turn runs) and the system's `alive` / `groupExists` / SIGKILL.
 */

import { userInfo } from 'node:os'
import type { Logger, Timers } from '@factotum/core'
import type { Callers } from '../callers.ts'
import { isAlive } from '../locks.ts'
import type { SessionPaths } from '../paths.ts'
import type { McpDeps } from '../questions/mcp.ts'
import { killGroup } from '../run.ts'
import type { Site } from '../sites.ts'
import type { EventInput, SessionEvent } from '../types.ts'
import { createServiceRegistry, reconcileServices, type ServiceRegistry } from './registry.ts'
import { groupExists } from './spawn.ts'
import { createServiceTable, type ServiceTable } from './table.ts'
import { createServiceTools, SERVICE_TOOLS } from './tools.ts'

/**
 * The owner's login shell, INTERACTIVE: measured under launchd with prod's PATH, only `-l -i -c` finds `pnpm`,
 * which the owner's `~/.zshrc` adds (tasks A1, decided by the owner 2026-10-02).
 */
export function loginShell(): readonly string[] {
  let shell: string | null = null
  try {
    shell = userInfo().shell
  } catch {
    // No passwd entry: fall through to the default.
  }
  return [shell ?? '/bin/zsh', '-l', '-i', '-c']
}

export interface ServicesDeps {
  /** Arrows, never methods of the store passed loose (it is a class with `#` fields). */
  readonly store: {
    readonly append: (sessionId: string, event: EventInput) => Promise<unknown>
    readonly read: (sessionId: string, fromSeq: number) => Promise<{ readonly events: readonly SessionEvent[] }>
  }
  readonly paths: SessionPaths
  readonly timers: Timers
  readonly now: () => Date
  readonly log: Logger
  readonly callers: Callers
  /** The site id while the session's turn runs: the engine's `live.get(id)?.siteId`. */
  readonly liveSiteId: (sessionId: string) => string | undefined
  /** `table.lastSite` of `createParts`, from an id to a `Site`. */
  readonly lastSite: (siteId: string) => Site | undefined
  readonly isStopped: () => boolean
  readonly seams?: ServiceSeams
}

/** What a test of the engine changes: never set by the daemon. */
export interface ServiceSeams {
  /** `/bin/sh -c` instead of the owner's login shell: a test does not read anybody's dotfiles. */
  readonly shell?: readonly string[]
  /** To hold `add` and watch a Cancel land in the middle of a start (criterion 43). */
  readonly wrapRegistry?: (registry: ServiceRegistry) => ServiceRegistry
}

export interface Services {
  readonly table: ServiceTable
  readonly mcp: McpDeps['services']
  readonly reconcile: () => Promise<void>
}

export function createServices(deps: ServicesDeps): Services {
  const events = async (sessionId: string): Promise<readonly SessionEvent[]> => (await deps.store.read(sessionId, 0)).events
  const real = createServiceRegistry(deps.paths.servicesRegistry, process.pid)
  const registry = deps.seams?.wrapRegistry?.(real) ?? real
  const table = createServiceTable({
    append: deps.store.append,
    events,
    registry,
    paths: deps.paths,
    shell: deps.seams?.shell ?? loginShell(),
    timers: deps.timers,
    now: deps.now,
    log: deps.log,
  })
  const liveSite = (sessionId: string): Site | undefined => {
    if (deps.isStopped()) return undefined
    const siteId = deps.liveSiteId(sessionId)
    return siteId === undefined ? undefined : deps.lastSite(siteId)
  }
  return {
    table,
    mcp: { tools: SERVICE_TOOLS, call: createServiceTools({ services: table, callers: deps.callers, liveSite }) },
    reconcile: async () =>
      await reconcileServices({
        registry,
        append: deps.store.append,
        events,
        alive: isAlive,
        groupExists,
        kill: (pgid) => killGroup(pgid, 'SIGKILL'),
        log: deps.log,
      }),
  }
}
