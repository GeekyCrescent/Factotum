/**
 * Turning notifications on, from the browser's side.
 *
 * TWO RULES, both taken from `main.tsx`, which already does this for the service worker:
 *
 * - NEVER THROWS. A failure is a state the screen can draw, not an exception. The shell works
 *   without push, exactly as it works without a service worker.
 * - PERMISSION IS ASKED FROM A CLICK AND FROM NOWHERE ELSE. `readPushState` only reads. Asking
 *   on load is what browsers penalise, and it asks before the owner knows what it is for.
 *
 * The browser is INJECTED (`PushEnvironment`) because `node --test` has no `navigator`, and a
 * test that cannot run is a test that is not there.
 */

export type PushState =
  | { readonly kind: 'unsupported'; readonly why: string }
  | { readonly kind: 'denied' }
  | { readonly kind: 'off' }
  | { readonly kind: 'on' }

export interface EnableResult {
  readonly state: PushState
  /** How many devices this machine now has — the screen shows it (spec criterion 54). */
  readonly count?: number
  /** What went wrong, in words the daemon chose where it chose them. */
  readonly error?: string
}

/** The two kernel-level calls, injected. `api.ts` provides the real ones. */
export interface PushApi {
  readonly publicKey: () => Promise<{ readonly ok: true; readonly publicKey: string } | { readonly ok: false; readonly message: string }>
  readonly subscribe: (
    subscription: unknown,
  ) => Promise<{ readonly ok: true; readonly count: number } | { readonly ok: false; readonly status: number; readonly message: string }>
}

interface MinimalPushSubscription {
  readonly options: { readonly applicationServerKey: ArrayBuffer | null }
  readonly toJSON: () => unknown
  readonly unsubscribe: () => Promise<boolean>
}

interface MinimalPushManager {
  readonly getSubscription: () => Promise<MinimalPushSubscription | null>
  readonly subscribe: (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => Promise<MinimalPushSubscription>
}

export interface PushEnvironment {
  readonly secure: boolean
  /** `undefined` where there is no service worker support at all. */
  readonly serviceWorkerReady: (() => Promise<{ readonly pushManager: MinimalPushManager }>) | undefined
  readonly pushSupported: boolean
  readonly permission: () => NotificationPermission
  readonly requestPermission: () => Promise<NotificationPermission>
}

export function browserPushEnvironment(): PushEnvironment {
  const hasWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
  const hasNotification = typeof Notification !== 'undefined'
  return {
    secure: typeof isSecureContext !== 'undefined' && isSecureContext,
    serviceWorkerReady: hasWorker ? async () => (await navigator.serviceWorker.ready) as never : undefined,
    pushSupported: typeof window !== 'undefined' && 'PushManager' in window,
    permission: () => (hasNotification ? Notification.permission : 'denied'),
    requestPermission: async () => (hasNotification ? await Notification.requestPermission() : 'denied'),
  }
}

/**
 * base64url (no padding) → bytes, for `applicationServerKey`.
 *
 * base64url is NOT base64: `-` and `_` stand where `+` and `/` do, and the padding is dropped.
 * Getting either wrong throws an InvalidCharacterError that looks like the browser's fault.
 */
export function base64urlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(base64)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function unsupported(env: PushEnvironment): PushState | undefined {
  if (!env.secure) return { kind: 'unsupported', why: 'this page is not a secure context — notifications need the https:// address' }
  if (env.serviceWorkerReady === undefined) return { kind: 'unsupported', why: 'this browser has no service workers' }
  if (!env.pushSupported) return { kind: 'unsupported', why: 'this browser does not support Web Push' }
  return undefined
}

/** READ ONLY. Never asks for permission. */
export async function readPushState(env: PushEnvironment = browserPushEnvironment()): Promise<PushState> {
  const blocked = unsupported(env)
  if (blocked !== undefined) return blocked
  if (env.permission() === 'denied') return { kind: 'denied' }
  try {
    const registration = await env.serviceWorkerReady!()
    return (await registration.pushManager.getSubscription()) === null ? { kind: 'off' } : { kind: 'on' }
  } catch {
    return { kind: 'off' }
  }
}

/** ONLY FROM A CLICK. The permission prompt requires a user gesture. */
export async function enablePush(api: PushApi, env: PushEnvironment = browserPushEnvironment()): Promise<EnableResult> {
  const blocked = unsupported(env)
  if (blocked !== undefined) return { state: blocked }

  try {
    const permission = await env.requestPermission()
    if (permission !== 'granted') return { state: permission === 'denied' ? { kind: 'denied' } : { kind: 'off' } }

    const key = await api.publicKey()
    if (!key.ok) return { state: { kind: 'unsupported', why: key.message } }
    const applicationServerKey = base64urlToBytes(key.publicKey)

    const { pushManager } = await env.serviceWorkerReady!()
    let subscription = await pushManager.getSubscription()

    // A subscription made with ANOTHER key — the daemon's pair was replaced — is one the push
    // service answers 403 to for ever (spec A6). Posting it would store a dead device.
    if (subscription !== null && !sameKey(subscription.options.applicationServerKey, applicationServerKey)) {
      await subscription.unsubscribe()
      subscription = null
    }
    subscription ??= await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })

    // Posted even when it already existed: the daemon may have been reset since.
    const stored = await api.subscribe(subscription.toJSON())
    if (!stored.ok) return { state: { kind: 'off' }, error: stored.message }
    return { state: { kind: 'on' }, count: stored.count }
  } catch (error) {
    return { state: { kind: 'off' }, error: error instanceof Error ? error.message : 'notifications could not be turned on' }
  }
}

function sameKey(existing: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (existing === null) return false
  const bytes = new Uint8Array(existing)
  return bytes.length === wanted.length && bytes.every((byte, i) => byte === wanted[i])
}
