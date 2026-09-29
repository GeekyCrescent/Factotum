/**
 * The pieces spec 2026-09-29 added to the engine, composed in one place so `engine.ts` keeps to
 * running sessions: the projects and their checks (`projects.ts`), the history index and its
 * operations (`index-cache.ts`, `history.ts`), and the folder requests (`permissions/grants.ts`,
 * `folders.ts`).
 *
 * THE INDEX IS WIRED TO THE STORE FIRST THING, so it hears every meta written from here on —
 * `reconcile`'s included — and is read in full once, at the end of `reconcile()` (D6, criterion 37).
 */

import { createFolders, type Folders } from './folders.ts'
import { createHistory, type History } from './history.ts'
import { SessionIndex } from './index-cache.ts'
import type { SiteLocks } from './locks.ts'
import { createGrantTable, type GrantTable } from './permissions/grants.ts'
import { createSiteTable, type SiteTable } from './projects.ts'
import type { DiskProbe } from './sites.ts'
import type { SessionStore } from './store.ts'
import type { EngineSetup } from './types.ts'

/** The seams of `EngineDeps` these pieces read. */
export interface PartsDeps {
  readonly caseInsensitive?: boolean
  readonly disk?: DiskProbe
  readonly checkMs?: number
  readonly grantTimeoutMs?: number
  readonly candidateTimeoutMs?: number
}

export interface PartsOwn {
  readonly store: SessionStore
  readonly locks: SiteLocks
  readonly liveCount: () => number
  readonly isLive: (id: string) => boolean
  readonly removing: string
}

export interface Parts {
  readonly table: SiteTable
  readonly index: SessionIndex
  readonly ensureIndex: () => Promise<void>
  readonly history: History
  readonly grants: GrantTable
  readonly folders: Folders
}

export async function createParts(setup: EngineSetup, deps: PartsDeps, own: PartsOwn): Promise<Parts> {
  const caseInsensitive = deps.caseInsensitive ?? process.platform === 'darwin'

  const table = createSiteTable({
    registry: setup.registry,
    home: setup.home,
    factotumRoot: setup.factotumRoot,
    installRoot: setup.installRoot,
    timers: setup.timers,
    log: setup.log,
    liveCount: own.liveCount,
    caseInsensitive,
    ...(deps.disk === undefined ? {} : { disk: deps.disk }),
    ...(deps.checkMs === undefined ? {} : { checkMs: deps.checkMs }),
  })
  await table.load()

  const index = new SessionIndex()
  own.store.observe({ written: (meta) => index.put(meta), removed: (id) => index.drop(id) })
  let building: Promise<void> | undefined
  const ensureIndex = (): Promise<void> => (building ??= index.build(own.store))

  const history = createHistory({
    store: own.store,
    index,
    ensureIndex,
    table,
    isLive: own.isLive,
    now: setup.now,
    registryFile: setup.registry.file,
    canRequest: () => setup.notify.canReach(),
  })

  const grants = createGrantTable({
    now: setup.now,
    timers: setup.timers,
    ...(deps.grantTimeoutMs === undefined ? {} : { timeoutMs: deps.grantTimeoutMs }),
  })

  const folders = createFolders({
    registry: setup.registry,
    table,
    grants,
    index,
    history,
    store: own.store,
    locks: own.locks,
    notify: setup.notify,
    log: setup.log,
    timers: setup.timers,
    now: setup.now,
    home: setup.home,
    factotumRoot: setup.factotumRoot,
    installRoot: setup.installRoot,
    caseInsensitive,
    disk: deps.disk,
    candidateTimeoutMs: deps.candidateTimeoutMs,
    liveCount: own.liveCount,
    isLive: own.isLive,
    removing: own.removing,
  })

  return { table, index, ensureIndex, history, grants, folders }
}
