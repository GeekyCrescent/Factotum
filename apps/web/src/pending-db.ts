/**
 * The pendings and the device settings, in IndexedDB — the window's side.
 *
 * THE SAME DATABASE AS public/sw.js, which writes the pendings: base `factotum`, stores `pending`
 * (key `key`) and `settings` (the record `device`, which sw.js reads). sw.js cannot import this file;
 * if the schema changes here, it changes there.
 *
 * THE LAUNCH HOST HAS ITS OWN RECORD, `launch`, in the same store (spec 2026-10-07-dos-hosts, design
 * D12) — never inside `device`: `writeSettings` puts that record whole, so a `{ launchHost }` there
 * would erase `sameMachine`, and sw.js takes a missing `sameMachine` as "the daemon's machine" and
 * drops the tokens. sw.js never reads `launch`, so it does not change.
 *
 * NO CONSOLE, anywhere in this file (criterion 37): a record may hold an ask token (ADR-0010), and
 * an error logged here could carry one. A failure means the pending does not show, and the
 * notification is still the way to answer.
 */

import { isPending, type Pending } from './pending.ts'

const DB = 'factotum'
const VERSION = 1
const PENDING = 'pending'
const SETTINGS = 'settings'
export const DEVICE_KEY = 'device'
export const LAUNCH_KEY = 'launch'

export interface DeviceSettings {
  /**
   * Whether this browser runs on the daemon's own machine (design D12). `undefined` until the
   * daemon has said, and the worker treats undefined as "yes": the safe default keeps no token.
   */
  readonly sameMachine?: boolean
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PENDING)) db.createObjectStore(PENDING, { keyPath: 'key' })
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
  })
}

async function run<T>(store: string, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(store, mode).objectStore(store))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
    })
  } finally {
    db.close()
  }
}

/** Every stored pending that has the right shape. Anything else is ignored, and never thrown. */
export async function allPending(): Promise<readonly Pending[]> {
  try {
    const rows = await run<unknown[]>(PENDING, 'readonly', (s) => s.getAll())
    return rows.filter(isPending)
  } catch {
    return []
  }
}

export async function removePending(keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    try {
      await run(PENDING, 'readwrite', (s) => s.delete(key))
    } catch {
      // Nothing to do: an entry that cannot be deleted expires on its own.
    }
  }
}

export async function readSettings(): Promise<DeviceSettings> {
  try {
    const value = await run<unknown>(SETTINGS, 'readonly', (s) => s.get(DEVICE_KEY))
    if (value === null || typeof value !== 'object') return {}
    const sameMachine = (value as Record<string, unknown>)['sameMachine']
    return typeof sameMachine === 'boolean' ? { sameMachine } : {}
  } catch {
    return {}
  }
}

export async function writeSettings(settings: DeviceSettings): Promise<void> {
  try {
    await run(SETTINGS, 'readwrite', (s) => s.put(settings, DEVICE_KEY))
  } catch {
    // The worker keeps treating the machine as unknown, which keeps no token: the safe side.
  }
}

/** The `launch` record: the name of the host this device last chose to launch on. */
export function launchRecord(name: string): { readonly host: string } {
  return { host: name }
}

/** The name in a `launch` record, or `undefined` for anything else. */
export function launchHostOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const host = (value as Record<string, unknown>)['host']
  return typeof host === 'string' && host !== '' ? host : undefined
}

/**
 * The name last chosen on this device, AS STORED: which one is the serving host, and whether it is
 * up, is the launcher's to decide with the hosts it has (`rememberedLaunchHost`). Never throws.
 */
export async function readLaunchHost(): Promise<string | undefined> {
  try {
    return launchHostOf(await run<unknown>(SETTINGS, 'readonly', (s) => s.get(LAUNCH_KEY)))
  } catch {
    return undefined
  }
}

export async function writeLaunchHost(name: string): Promise<void> {
  try {
    await run(SETTINGS, 'readwrite', (s) => s.put(launchRecord(name), LAUNCH_KEY))
  } catch {
    // Not remembered: the next New opens on the serving host, as it always did.
  }
}
