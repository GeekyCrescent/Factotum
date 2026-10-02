/**
 * `services.json`, and what the next start does with it (spec 2026-10-02-servicios-en-segundo-plano, D6).
 *
 * ONE LIST FOR THE WHOLE DAEMON, because on the way back up the live ones have to be found without walking
 * every session. `daemonPid` is the pid of whoever wrote it: the same second opinion as a lock's pid
 * (`lifecycle.ts`, row 1).
 *
 * WRITTEN ATOMICALLY AND IN A CHAIN. Temp + `rename`, like the rest of the package's state; and every `add`
 * / `remove` / `clear` does its read-modify-write inside its own link. Without the chain two concurrent
 * `add`s lose one entry (second audit), and an entry the reconcile cannot find is a process nobody kills.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import type { Logger } from '@factotum/core'
import type { EventInput, SessionEvent } from '../types.ts'
import { RESTART_REASON } from './shape.ts'

export interface RegistryEntry {
  readonly sessionId: string
  readonly id: string
  /** The leader's pid, which is the group's id. */
  readonly pid: number
  readonly startedAt: string
}

export type RegistryRead =
  | { readonly kind: 'empty' }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'ok'; readonly daemonPid: number; readonly services: readonly RegistryEntry[] }

export interface ServiceRegistry {
  /** This daemon's pid, the one every write stamps. */
  readonly daemonPid: number
  readonly read: () => Promise<RegistryRead>
  readonly add: (entry: RegistryEntry) => Promise<void>
  readonly remove: (sessionId: string, id: string) => Promise<void>
  readonly clear: () => Promise<void>
  /** A corrupt file goes to `services.json.bad`: treated as empty, but the evidence is kept. */
  readonly quarantine: () => Promise<void>
}

const isEntry = (value: unknown): value is RegistryEntry => {
  const record = value as Partial<RegistryEntry> | null
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.sessionId === 'string' &&
    typeof record.id === 'string' &&
    Number.isInteger(record.pid) &&
    typeof record.startedAt === 'string'
  )
}

function parse(text: string): RegistryRead {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { kind: 'corrupt' }
  }
  const record = json as { daemonPid?: unknown; services?: unknown } | null
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return { kind: 'corrupt' }
  if (!Number.isInteger(record.daemonPid) || !Array.isArray(record.services) || !record.services.every(isEntry)) {
    return { kind: 'corrupt' }
  }
  return { kind: 'ok', daemonPid: record.daemonPid as number, services: record.services }
}

export function createServiceRegistry(file: string, daemonPid: number): ServiceRegistry {
  let chain: Promise<unknown> = Promise.resolve()

  /** One link. A rejected link must not poison the next caller (the store's `#take`). */
  function link<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work, work)
    chain = next.catch(() => undefined)
    return next
  }

  async function readNow(): Promise<RegistryRead> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'empty' }
      // NOT corrupt: a file that cannot be read now may hold live groups, and quarantining it would lose them.
      throw error
    }
    return parse(text)
  }

  async function update(change: (services: readonly RegistryEntry[]) => readonly RegistryEntry[]): Promise<void> {
    const current = await readNow()
    const services = current.kind === 'ok' ? current.services : []
    const temp = `${file}.tmp`
    await writeFile(temp, `${JSON.stringify({ daemonPid, services: change(services) }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, file)
  }

  return {
    daemonPid,
    read: async () => await link(readNow),
    add: async (entry) => await link(() => update((services) => [...services, entry])),
    remove: async (sessionId, id) =>
      await link(() => update((services) => services.filter((s) => !(s.sessionId === sessionId && s.id === id)))),
    clear: async () => await link(() => update(() => [])),
    quarantine: async () => await link(async () => await rename(file, `${file}.bad`)),
  }
}

export interface ReconcileServicesDeps {
  readonly registry: ServiceRegistry
  readonly append: (sessionId: string, event: EventInput) => Promise<unknown>
  readonly events: (sessionId: string) => Promise<readonly SessionEvent[]>
  /** For `daemonPid`: `isAlive` in the engine. */
  readonly alive: (pid: number) => boolean
  readonly groupExists: (pgid: number) => boolean
  /** SIGKILL to the group. Injected so a test can watch it without owning a group; the engine's is `killGroup`. */
  readonly kill: (pgid: number) => void
  readonly log: Logger
}

/**
 * On the way back up (criterion 25), inside `reconcile()`, AFTER `reconcileLocks`. NEVER THROWS
 * (guardrail 12): it runs inside `start()`, where a throw disables the module.
 *
 * SIGKILL, NOT SIGTERM: there is no timer to be had here, and a `trap '' TERM` would survive for ever.
 * THE GROUP, NOT THE LEADER: `stop()`'s SIGTERM can kill the shell and leave a trapping child in the group,
 * with the dead leader's pid as its pgid — only asking about the group finds it (second audit).
 */
export async function reconcileServices(deps: ReconcileServicesDeps): Promise<void> {
  let read: RegistryRead
  try {
    read = await deps.registry.read()
    if (read.kind === 'corrupt') {
      deps.log.warn('services.json could not be read; it was moved to services.json.bad and treated as empty')
      await deps.registry.quarantine()
      return
    }
  } catch (error) {
    deps.log.warn(`services.json could not be reconciled: ${error instanceof Error ? error.message : 'error'}`)
    return
  }
  if (read.kind === 'empty') return

  // Row 1 of `lifecycle.ts`: another live daemon owns this environment. Touch nothing.
  if (read.daemonPid !== deps.registry.daemonPid && deps.alive(read.daemonPid)) {
    deps.log.warn(`services.json belongs to live pid ${read.daemonPid}; another daemon may own this environment, so no service was reconciled`)
    return
  }

  for (const entry of read.services) {
    try {
      if (deps.groupExists(entry.pid)) {
        deps.kill(entry.pid)
        deps.log.warn(`killed the leftover group of service ${entry.id} of session ${entry.sessionId}`)
      }
      const events = await deps.events(entry.sessionId)
      const closed = events.some((event) => event.kind === 'service' && event.phase === 'ended' && event.id === entry.id)
      if (!closed) {
        await deps.append(entry.sessionId, { kind: 'service', phase: 'ended', id: entry.id, outcome: 'shutdown', reason: RESTART_REASON })
      }
    } catch (error) {
      // One entry, never the module: a session deleted since, a log that cannot be written.
      deps.log.warn(`service ${entry.id} of session ${entry.sessionId} could not be reconciled: ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  try {
    await deps.registry.clear()
  } catch (error) {
    deps.log.warn(`services.json could not be cleared: ${error instanceof Error ? error.message : 'error'}`)
  }
}
