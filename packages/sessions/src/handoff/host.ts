/**
 * What the handoff needs of THIS host, handed over by the engine (spec 2026-10-07-dos-hosts). The
 * handoff never sees the engine: it gets these reads and writes, so its tests build a host in a few
 * lines and the engine stays the one place that owns the store, the locks and the index.
 */

import type { Logger, PeerCaller, Timers } from '@factotum/core'
import type { SiteLocks } from '../locks.ts'
import type { SessionPaths } from '../paths.ts'
import type { SessionMeta, SessionStore } from '../store.ts'

export interface HandoffProject {
  readonly id: string
  /** The path the engine launches in and `reply` compares with: `meta.sitePath` is written from it. */
  readonly path: string
}

export interface HandoffHost {
  readonly paths: SessionPaths
  readonly store: SessionStore
  readonly locks: SiteLocks
  /** Registered projects that are THERE, in the owner's order. */
  readonly projects: () => readonly HandoffProject[]
  /** Every session of one project this host knows, from the index. */
  readonly sessionsOf: (siteId: string) => readonly SessionMeta[]
  /** The ids of this host's catalog: what a session's `entryId` must be one of. */
  readonly entries: () => readonly string[]
  /** The owner's uploads root, `<stateDir>/uploads`. */
  readonly uploadsRoot: string
  /** `~/.claude/projects`. */
  readonly claudeProjects: string
  /** Stops a session's services, as the owner's Stop does; answers which were stopped (D9, step 5). */
  readonly stopServices: (sessionId: string) => Promise<readonly string[]>
  readonly peers: PeerCaller
  readonly log: Logger
  readonly now: () => Date
  readonly timers: Timers
  /** The environment git runs with. Tests point it at an empty global config. */
  readonly gitEnv?: NodeJS.ProcessEnv
}
