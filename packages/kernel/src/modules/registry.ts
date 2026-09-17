/**
 * The live set of modules: their contexts, their routes, and their background work.
 *
 * The registry RECEIVES the module list, it never imports it. That is what keeps
 * `packages/kernel` free of every module name — `packages/cli` is the composition
 * root and passes them in. It is the same injection the predecessor project applies
 * to its capabilities, moved up one level so that it covers whole modules.
 */

import { mkdir } from 'node:fs/promises'
import { prefixed, type Environment, type ModuleResponse, type ModuleStatus, type NavEntry, type NotificationMessage, type Timers } from '@factotum/core'
import type { ComposedModule } from '../config/load.ts'
import { moduleStateDir, type StatePaths } from '../config/paths.ts'
import type { PushService } from '../push/service.ts'
import { compileRoutes, buildRequest, matchRoute, type CompiledRoute } from './mount.ts'

/**
 * A `start` that hangs is worse than one that throws: with the readiness flag, the
 * whole daemon would sit at 503 forever instead of one route answering badly.
 * The predecessor puts a timeout on everything that calls out of the process for
 * exactly this reason.
 */
export const MODULE_START_TIMEOUT_MS = 10_000

export interface RegistryDeps {
  readonly paths: StatePaths
  readonly env: Environment
  readonly now?: () => Date
  readonly startTimeoutMs?: number
  /**
   * The daemon's push capability, ALREADY BUILT — `boot` builds it, because only `boot` knows
   * `publicOrigin` and therefore the machine's name. The registry is given the capability and
   * never the config: a registry that knew `publicOrigin` could start deciding the network
   * surface, which lives in one place on purpose.
   *
   * REQUIRED, not optional. An optional capability that silently does nothing is a degradation
   * nobody sees; ADR-0004 degrades CONFIG, not wiring. When push is off, what arrives here is a
   * service whose `canReach` says so.
   */
  readonly push: Pick<PushService, 'canReach' | 'send'>
}

export interface ModuleSummary {
  readonly id: string
  readonly nav?: NavEntry
  readonly status: ModuleStatus
}

// `| undefined` rather than `?`, because `exactOptionalPropertyTypes` is on and
// these are assigned explicitly from values that may be absent. The public
// `ModuleSummary` keeps the cleaner `?` and `list()` builds it conditionally.
interface Entry {
  readonly id: string
  readonly nav: NavEntry | undefined
  readonly status: ModuleStatus
  readonly routes: readonly CompiledRoute[]
  readonly timers: TimerSet
  readonly start: (() => Promise<{ stop: () => Promise<void> | void }>) | undefined
  readonly handle?: { stop: () => Promise<void> | void }
}

interface TimerSet {
  readonly timers: Timers
  readonly disposeAll: () => void
}

/**
 * The kernel owns every timer it hands out.
 *
 * Without this, a `start` that creates an interval and THEN throws leaves the module
 * disabled — with no `ModuleHandle` to call — and the interval still running, so the
 * process never exits on SIGINT. `unref` on top means a module's background work
 * never by itself keeps the daemon alive.
 */
function timerSet(): TimerSet {
  const live = new Set<() => void>()

  const track = (cancel: () => void): Disposable => {
    live.add(cancel)
    return {
      [Symbol.dispose]: () => {
        cancel()
        live.delete(cancel)
      },
    }
  }

  return {
    timers: {
      setInterval: (fn, ms) => {
        const handle = setInterval(fn, ms)
        handle.unref?.()
        return track(() => clearInterval(handle))
      },
      setTimeout: (fn, ms) => {
        const handle = setTimeout(fn, ms)
        handle.unref?.()
        return track(() => clearTimeout(handle))
      },
    },
    disposeAll: () => {
      for (const cancel of live) cancel()
      live.clear()
    },
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms)
    timer.unref?.()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error as Error)
      },
    )
  })
}

export class Registry {
  #entries: readonly Entry[]
  readonly #timeoutMs: number

  private constructor(entries: readonly Entry[], timeoutMs: number) {
    this.#entries = entries
    this.#timeoutMs = timeoutMs
  }

  /** Steps 7 and 8 of boot: state directories, contexts, route tables. Nothing runs. */
  static async create(
    composed: readonly ComposedModule[],
    deps: RegistryDeps,
  ): Promise<Registry> {
    const now = deps.now ?? (() => new Date())
    const entries: Entry[] = []

    for (const { module, status, config } of composed) {
      const timers = timerSet()

      if (status.kind === 'disabled') {
        // No context exists — its config never parsed — so there is nothing to ask
        // for a route table. The kernel serves the 501 itself.
        entries.push({
          id: module.id,
          nav: module.nav,
          status,
          routes: [],
          timers,
          start: undefined,
        })
        continue
      }

      const stateDir = moduleStateDir(deps.paths, module.id)
      await mkdir(stateDir, { recursive: true })

      const moduleId = module.id
      const ctx = {
        config,
        stateDir,
        env: deps.env,
        log: prefixed(module.id),
        now,
        timers: timers.timers,
        // THE ID IS BOUND HERE, not passed by the module. Same move as the route prefix and the
        // log prefix: a module cannot claim to be another module, or the daemon (`null`).
        notify: {
          canReach: () => deps.push.canReach(),
          send: (message: NotificationMessage) => deps.push.send(message, moduleId),
        },
      }

      entries.push({
        id: module.id,
        nav: module.nav,
        status,
        routes: module.routes ? compileRoutes(module.id, module.routes(ctx)) : [],
        timers,
        start: module.start
          ? async () => await module.start!(ctx)
          : undefined,
      })
    }

    return new Registry(entries, deps.startTimeoutMs ?? MODULE_START_TIMEOUT_MS)
  }

  /**
   * Step 12 of boot, run only after the bind has been verified.
   *
   * A module that throws or hangs is disabled with the reason and the daemon carries
   * on: config errors degrade, and a module failing to reach its provider is a
   * config-shaped error. Its timers are disposed so nothing it managed to arm
   * survives.
   */
  async startAll(): Promise<void> {
    const next: Entry[] = []

    for (const entry of this.#entries) {
      if (entry.status.kind === 'disabled' || entry.start === undefined) {
        next.push(entry)
        continue
      }

      try {
        const handle = await withTimeout(
          Promise.resolve(entry.start()),
          this.#timeoutMs,
          () => new Error(`start() did not finish within ${this.#timeoutMs}ms`),
        )
        next.push({ ...entry, handle })
      } catch (error) {
        entry.timers.disposeAll()
        next.push({
          ...entry,
          status: {
            kind: 'disabled',
            reason: `start failed: ${error instanceof Error ? error.message : String(error)}`,
          },
          routes: [],
        })
      }
    }

    this.#entries = next
  }

  /** Reverse order, and a module that throws on the way down does not stop the rest. */
  async stopAll(): Promise<void> {
    for (const entry of [...this.#entries].reverse()) {
      try {
        await entry.handle?.stop()
      } catch {
        // Shutting down: nothing useful is left to do about it.
      }
      entry.timers.disposeAll()
    }
  }

  list(): readonly ModuleSummary[] {
    return this.#entries.map(({ id, nav, status }) =>
      nav === undefined ? { id, status } : { id, nav, status },
    )
  }

  /**
   * `undefined` means no such module — the caller turns that into a 404, which is
   * also what a module that is OFF looks like, because it was never registered.
   */
  async dispatch(
    id: string,
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
  ): Promise<ModuleResponse | undefined> {
    const entry = this.#entries.find((candidate) => candidate.id === id)
    if (entry === undefined) return undefined

    if (entry.status.kind === 'disabled') {
      return { status: 501, body: { error: { code: 'module-disabled', message: entry.status.reason } } }
    }

    const matched = matchRoute(entry.routes, method, path)
    if (matched === undefined) {
      return { status: 404, body: { error: { code: 'not-found', message: `no route ${method} ${path} in module "${id}"` } } }
    }

    return await matched.handler(buildRequest(method, path, matched.params, query, body))
  }
}
