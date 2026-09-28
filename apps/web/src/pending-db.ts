/**
 * The pendings and the device settings, in IndexedDB — the window's side.
 *
 * THE SAME DATABASE AS public/sw.js, which writes the pendings: base `factotum`, stores `pending`
 * (key `key`) and `settings` (one record, key `device`). sw.js cannot import this file; if the
 * schema changes here, it changes there.
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
const DEVICE = 'device'

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
    const value = await run<unknown>(SETTINGS, 'readonly', (s) => s.get(DEVICE))
    if (value === null || typeof value !== 'object') return {}
    const sameMachine = (value as Record<string, unknown>)['sameMachine']
    return typeof sameMachine === 'boolean' ? { sameMachine } : {}
  } catch {
    return {}
  }
}

export async function writeSettings(settings: DeviceSettings): Promise<void> {
  try {
    await run(SETTINGS, 'readwrite', (s) => s.put(settings, DEVICE))
  } catch {
    // The worker keeps treating the machine as unknown, which keeps no token: the safe side.
  }
}
