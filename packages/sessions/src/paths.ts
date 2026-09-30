/**
 * Where the engine's state lives, under a root it is HANDED.
 *
 * Nothing here composes a path from `~`. `ctx.stateDir` is already
 * `~/.factotum/<env>/modules/sessions/`, created by the kernel before the context
 * existed, and building on top of it is what keeps `dev` and `prod` from sharing a
 * single session — and what lets every test point the whole engine at a temp dir.
 */

import { join } from 'node:path'

export interface SessionPaths {
  readonly root: string
  /** One file per SITE, not per session: the lock is what makes a site exclusive. */
  readonly locks: string
  readonly sessions: string
  /**
   * The titler's working directory (spec 2026-09-30, D7): empty, and never a project's folder, so a
   * prompt that says "read secrets.env" has nothing there to read even if tools came back.
   */
  readonly titler: string
  readonly lockFile: (siteId: string) => string
  readonly sessionDir: (sessionId: string) => string
  readonly metaFile: (sessionId: string) => string
  readonly eventsFile: (sessionId: string) => string
  readonly settingsFile: (sessionId: string) => string
}

export function sessionPaths(stateDir: string): SessionPaths {
  const locks = join(stateDir, 'locks')
  const sessions = join(stateDir, 'sessions')
  const sessionDir = (sessionId: string): string => join(sessions, sessionId)

  return {
    root: stateDir,
    locks,
    sessions,
    titler: join(stateDir, 'titler'),
    lockFile: (siteId) => join(locks, `${siteId}.json`),
    sessionDir,
    metaFile: (sessionId) => join(sessionDir(sessionId), 'meta.json'),
    eventsFile: (sessionId) => join(sessionDir(sessionId), 'events.jsonl'),
    settingsFile: (sessionId) => join(sessionDir(sessionId), 'settings.json'),
  }
}
