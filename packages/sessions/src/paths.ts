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
  /**
   * One DIRECTORY per site, one file per holder (spec 2026-10-03-varias-sesiones-por-proyecto, D2). A
   * site whose project allows several sessions at once holds several; any other holds at most one.
   */
  readonly locks: string
  readonly sessions: string
  /**
   * The titler's working directory (spec 2026-09-30, D7): empty, and never a project's folder, so a
   * prompt that says "read secrets.env" has nothing there to read even if tools came back.
   */
  readonly titler: string
  /**
   * What the owner attached (spec 2026-10-01, D5): `uploads/<uploadId>/<name>`. A sibling of
   * `sessions/`, not inside a session: on a LAUNCH the file is sent before the session exists.
   */
  readonly uploads: string
  /**
   * THE OLD LAYOUT, one file per site (`locks/<siteId>.json`). Nothing writes it any more; it is read
   * and released so a daemon from before the change leaves nothing behind. Kept under its name so the
   * tests that write it — an unreadable lock, a lock of the old layout — still do.
   */
  readonly lockFile: (siteId: string) => string
  /** `locks/<siteId>/`: the holders of one site. Never collides with `lockFile` — a site id has no dot. */
  readonly lockDir: (siteId: string) => string
  /** `locks/<siteId>/<holderId>.json`: one holder — a session id, or `removing`. */
  readonly holderFile: (siteId: string, holderId: string) => string
  readonly sessionDir: (sessionId: string) => string
  readonly metaFile: (sessionId: string) => string
  readonly eventsFile: (sessionId: string) => string
  readonly settingsFile: (sessionId: string) => string
  /** The `--mcp-config` file (spec 2026-10-01-preguntas-con-opciones, D4). */
  readonly mcpConfigFile: (sessionId: string) => string
  /**
   * The live background services of the WHOLE daemon (spec 2026-10-02-servicios-en-segundo-plano, D6): one
   * list, so the next start finds them without walking every session.
   */
  readonly servicesRegistry: string
  /** A session's service output. INSIDE its directory, so deleting the session takes it along (criterion 22). */
  readonly servicesDir: (sessionId: string) => string
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
    uploads: join(stateDir, 'uploads'),
    lockFile: (siteId) => join(locks, `${siteId}.json`),
    lockDir: (siteId) => join(locks, siteId),
    holderFile: (siteId, holderId) => join(locks, siteId, `${holderId}.json`),
    sessionDir,
    metaFile: (sessionId) => join(sessionDir(sessionId), 'meta.json'),
    eventsFile: (sessionId) => join(sessionDir(sessionId), 'events.jsonl'),
    settingsFile: (sessionId) => join(sessionDir(sessionId), 'settings.json'),
    mcpConfigFile: (sessionId) => join(sessionDir(sessionId), 'mcp.json'),
    servicesRegistry: join(stateDir, 'services.json'),
    servicesDir: (sessionId) => join(sessionDir(sessionId), 'services'),
  }
}
