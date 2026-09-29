/**
 * The projects as the engine holds them: the registry's entries, the last check of each folder, and
 * the shared folders the gate uses (spec 2026-09-29, design D2). Kept apart from `engine.ts`, which
 * carries the sessions.
 *
 * A FOLDER THAT IS NOT THERE FAILS ALONE (criterion 23). Each project carries its last check —
 * `ok` or `missing` — and it is checked again before anything that would use the folder: a launch,
 * a reply, a read, the projects list. A `missing` project launches nothing and is not read; the
 * others carry on. That only ever narrows the boundary, which is why it needs no approval.
 *
 * `lastSite` IS WHAT THE GATE USES, not the latest check. A session already running in a project
 * whose folder then goes missing keeps the boundary it started with (criterion 23): the gate must
 * not start denying a live agent because a check somewhere else failed. The disk narrows it anyway.
 *
 * EVERY CHECK HAS A CEILING, and ONE IS IN FLIGHT PER FOLDER. A folder on a hung mount must not
 * disable the module at start (the kernel gives `start()` ten seconds), and a screen polling the
 * list must not add one stuck libuv thread per poll (`bounded.ts`).
 */

import type { Logger, Timers } from '@factotum/core'
import { bounded } from './bounded.ts'
import { canonicalPath, checkSite, contains, realDisk, type DiskProbe, type Site, type SiteCheck } from './sites.ts'
import type { Color, EngineSetupView, ProjectEntry, RegistryStore, RegistryView, SharedView, SkippedEntry } from './types.ts'

/** How long one folder check may take before the folder counts as missing. */
export const SITE_CHECK_MS = 5_000

/** The id a shared folder is inspected under. Nothing launches there and nothing locks it. */
const SHARED_ID = 'shared'

export interface SiteTableDeps {
  readonly registry: RegistryStore
  readonly home: string
  readonly factotumRoot: string
  readonly installRoot: string | undefined
  readonly timers: Timers
  readonly log: Logger
  /** How many sessions are live, so the gate's shared list only changes when none is (criterion 20). */
  readonly liveCount: () => number
  readonly checkMs?: number
  readonly disk?: DiskProbe
  readonly caseInsensitive: boolean
}

interface ProjectState {
  readonly entry: ProjectEntry
  check: SiteCheck | undefined
  lastSite: Site | undefined
}

interface SharedState {
  readonly path: string
  check: SiteCheck | undefined
}

export interface SiteTable {
  /** At start. Never throws: a broken registry is a value, said in `broken()`. */
  readonly load: () => Promise<void>
  readonly broken: () => string | undefined
  readonly skipped: () => readonly SkippedEntry[]
  readonly entries: () => readonly ProjectEntry[]
  readonly entry: (id: string) => ProjectEntry | undefined
  /** Checks one project again. `undefined`: no such project is registered. */
  readonly refresh: (id: string) => Promise<SiteCheck | undefined>
  /** Every project and shared folder again, for the projects list (criteria 20, 24). */
  readonly refreshAll: () => Promise<void>
  readonly status: (id: string) => 'ok' | 'missing' | undefined
  readonly reason: (id: string) => string | undefined
  readonly lastSite: (id: string) => Site | undefined
  /** What the gate treats as writable from every site. Changes only as criterion 20 says. */
  readonly gateShared: () => readonly Site[]
  readonly sharedViews: () => readonly SharedView[]
  readonly registryView: () => RegistryView
  /**
   * After the registry wrote: the entries it has now. New projects are checked, removed ones
   * forgotten, renamed ones renamed. The gate's shared list is rebuilt only when `rebuildShared`.
   */
  readonly apply: (registry: RegistryView, rebuildShared: boolean) => Promise<void>
  readonly sites: () => EngineSetupView['sites']
}

export function createSiteTable(deps: SiteTableDeps): SiteTable {
  const disk = deps.disk ?? realDisk
  const checkMs = deps.checkMs ?? SITE_CHECK_MS
  const projects = new Map<string, ProjectState>()
  let shared: SharedState[] = []
  let gate: readonly Site[] = []
  let brokenReason: string | undefined
  let skipped: readonly SkippedEntry[] = []
  const inflight = new Map<string, Promise<SiteCheck>>()

  /** One check per folder at a time, each with its ceiling. */
  const check = (key: string, id: string, path: string): Promise<SiteCheck> => {
    const running = inflight.get(key)
    const work =
      running ??
      checkSite({ id, path }).finally(() => {
        inflight.delete(key)
      })
    if (running === undefined) inflight.set(key, work)
    return bounded(work, checkMs, deps.timers, (): SiteCheck => ({ status: 'missing', reason: `checking ${path} timed out` }))
  }

  const checkProject = async (state: ProjectState): Promise<SiteCheck> => {
    const result = await check(`project:${state.entry.id}`, state.entry.id, state.entry.path)
    state.check = result
    if (result.status === 'ok') state.lastSite = result.site
    return result
  }

  const checkShared = async (state: SharedState): Promise<SiteCheck> => {
    const result = await check(`shared:${state.path}`, SHARED_ID, state.path)
    state.check = result
    return result
  }

  const rebuildGate = (): void => {
    gate = shared.flatMap((s) => (s.check?.status === 'ok' ? [s.check.site] : []))
  }

  /**
   * What was seeded or typed by hand is NOT revalidated (out of scope), but it is SAID: a registry
   * whose entries break the rules a request would have to pass starts with a warning per entry.
   */
  const audit = async (registry: RegistryView): Promise<void> => {
    const fold = (value: string): string => (deps.caseInsensitive ? value.toLowerCase() : value)
    const canonical = await Promise.all(registry.projects.map(async (p) => ({ id: p.id, path: fold(await canonicalPath(p.path, disk)) })))
    const home = fold(await canonicalPath(deps.home, disk))
    const roots = await Promise.all(
      [deps.factotumRoot, deps.installRoot].flatMap((root) => (root === undefined ? [] : [canonicalPath(root, disk)])),
    )
    for (const [i, a] of canonical.entries()) {
      if (a.path === '/' || a.path === home) deps.log.warn(`project "${a.id}" is ${a.path === '/' ? 'the root of the disk' : 'the home folder'}; a request for it would be refused`)
      for (const root of roots) {
        if (contains(fold(root), a.path) || contains(a.path, fold(root))) deps.log.warn(`project "${a.id}" is, holds or sits inside ${root}; a request for it would be refused`)
      }
      for (const b of canonical.slice(i + 1)) {
        if (contains(a.path, b.path) || contains(b.path, a.path)) deps.log.warn(`projects "${a.id}" and "${b.id}" overlap; a request for either would be refused`)
      }
    }
  }

  const reset = (registry: RegistryView): void => {
    projects.clear()
    for (const entry of registry.projects) projects.set(entry.id, { entry, check: undefined, lastSite: undefined })
    shared = registry.shared.map((s) => ({ path: s.path, check: undefined }))
  }

  return {
    load: async () => {
      const loaded = await deps.registry.load()
      if (loaded.kind === 'broken') {
        brokenReason = loaded.reason
        deps.log.warn(`the projects registry is broken, so no project is loaded: ${loaded.reason}`)
        return
      }
      for (const warning of loaded.warnings) deps.log.warn(warning)
      skipped = loaded.skipped
      reset(loaded.registry)
      await bounded(audit(loaded.registry), checkMs, deps.timers, () => deps.log.warn('checking the registry against the rules timed out'))
      await Promise.all([...[...projects.values()].map(checkProject), ...shared.map(checkShared)])
      for (const state of projects.values()) {
        if (state.check?.status === 'missing') deps.log.warn(`project "${state.entry.id}" is missing: ${state.check.reason}`)
      }
      for (const state of shared) {
        if (state.check?.status === 'missing') deps.log.warn(`shared folder ${state.path} is missing: ${state.check.reason}`)
      }
      rebuildGate()
    },

    broken: () => brokenReason,
    skipped: () => skipped,
    entries: () => [...projects.values()].map((state) => state.entry),
    entry: (id) => projects.get(id)?.entry,

    refresh: async (id) => {
      const state = projects.get(id)
      return state === undefined ? undefined : await checkProject(state)
    },

    refreshAll: async () => {
      const wasMissing = new Set(shared.filter((s) => s.check?.status !== 'ok').map((s) => s.path))
      await Promise.all([...[...projects.values()].map(checkProject), ...shared.map(checkShared)])
      // A shared folder that came back joins the gate — but only with nothing running, so no live
      // session's boundary changes under it (criterion 20, guardrail 5).
      const cameBack = shared.some((s) => wasMissing.has(s.path) && s.check?.status === 'ok')
      if (cameBack && deps.liveCount() === 0) rebuildGate()
    },

    status: (id) => projects.get(id)?.check?.status,
    reason: (id) => {
      const current = projects.get(id)?.check
      return current?.status === 'missing' ? current.reason : undefined
    },
    lastSite: (id) => projects.get(id)?.lastSite,
    gateShared: () => gate,

    sharedViews: () =>
      shared.map((s) => ({
        path: s.path,
        status: s.check?.status === 'ok' ? 'ok' : 'missing',
        reason: s.check?.status === 'missing' ? s.check.reason : undefined,
      })),

    registryView: () => ({ projects: [...projects.values()].map((state) => state.entry), shared: shared.map((s) => ({ path: s.path })) }),

    apply: async (registry, rebuildShared) => {
      const before = projects
      const fresh = new Map<string, ProjectState>()
      for (const entry of registry.projects) {
        const old = before.get(entry.id)
        fresh.set(entry.id, { entry, check: old?.check, lastSite: old?.lastSite })
      }
      projects.clear()
      for (const [id, state] of fresh) projects.set(id, state)
      const oldShared = new Map(shared.map((s) => [s.path, s]))
      shared = registry.shared.map((s) => oldShared.get(s.path) ?? { path: s.path, check: undefined })
      await Promise.all([
        ...[...projects.values()].filter((state) => state.check === undefined).map(checkProject),
        ...shared.filter((s) => s.check === undefined).map(checkShared),
      ])
      if (rebuildShared) rebuildGate()
    },

    sites: () =>
      [...projects.values()].map((state) => ({
        id: state.entry.id,
        path: state.lastSite?.path ?? state.entry.path,
        isRepo: state.lastSite?.isRepo ?? false,
        name: state.entry.name,
        color: state.entry.color as Color | undefined,
        status: state.check?.status === 'ok' ? 'ok' : 'missing',
      })),
  }
}
