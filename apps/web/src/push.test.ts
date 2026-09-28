import { test } from 'node:test'
import assert from 'node:assert/strict'
import { base64urlToBytes, enablePush, readPushState, resubscribe, type PushApi, type PushEnvironment } from './push.ts'

// ---------------------------------------------------------------------------
// base64url → bytes: the line everybody writes wrong
// ---------------------------------------------------------------------------

test('base64url is NOT base64: `-` and `_` decode to 0xfb 0xff', () => {
  // `+/8=` in base64 is `-_8` in base64url. Translating one alphabet and not the other — or
  // forgetting the padding — gives an InvalidCharacterError that looks like the browser's fault.
  assert.deepEqual([...base64urlToBytes('-_8')], [0xfb, 0xff])
})

test('a VAPID-length key round-trips against an independent encoder (Node’s Buffer)', () => {
  const point = Buffer.from([0x04, ...Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff)])
  const encoded = point.toString('base64url')
  assert.equal(encoded.length, 87)

  const decoded = base64urlToBytes(encoded)
  assert.equal(decoded.length, 65)
  assert.equal(decoded[0], 0x04, 'an uncompressed P-256 point starts with 0x04')
  assert.deepEqual([...decoded], [...point])
})

// ---------------------------------------------------------------------------
// A browser, faked
// ---------------------------------------------------------------------------

const KEY = Buffer.from([0x04, ...Array.from({ length: 64 }, (_, i) => i)]).toString('base64url')

interface FakeSubscription {
  readonly endpoint: string
  unsubscribed: boolean
  readonly options: { readonly applicationServerKey: ArrayBuffer }
  readonly toJSON: () => unknown
  readonly unsubscribe: () => Promise<boolean>
}

function browser(opts: {
  secure?: boolean
  worker?: boolean
  push?: boolean
  permission?: NotificationPermission
  grant?: NotificationPermission
  existingKey?: string
}) {
  let permission = opts.permission ?? 'default'
  let current: FakeSubscription | undefined
  const subscribed: string[] = []

  const make = (key: string): FakeSubscription => {
    const bytes = Buffer.from(key, 'base64url')
    const sub: FakeSubscription = {
      endpoint: `https://fcm.googleapis.com/fcm/send/${subscribed.length}`,
      unsubscribed: false,
      options: { applicationServerKey: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
      toJSON: () => ({ endpoint: sub.endpoint, keys: { p256dh: 'BP', auth: 'au' } }),
      unsubscribe: async () => {
        sub.unsubscribed = true
        current = undefined
        return true
      },
    }
    return sub
  }
  if (opts.existingKey !== undefined) current = make(opts.existingKey)

  const pushManager = {
    getSubscription: async () => current ?? null,
    subscribe: async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
      const key = Buffer.from(applicationServerKey).toString('base64url')
      subscribed.push(key)
      current = make(key)
      return current
    },
  }

  const env: PushEnvironment = {
    secure: opts.secure ?? true,
    serviceWorkerReady: opts.worker === false ? undefined : async () => ({ pushManager }) as never,
    pushSupported: opts.push ?? true,
    permission: () => permission,
    requestPermission: async () => (permission = opts.grant ?? 'granted'),
  }
  return { env, subscribed, current: () => current }
}

function api(opts: { publicKey?: string | Error; subscribe?: Awaited<ReturnType<PushApi['subscribe']>> } = {}) {
  const posted: unknown[] = []
  const value: PushApi = {
    publicKey: async () =>
      opts.publicKey instanceof Error
        ? { ok: false, message: opts.publicKey.message }
        : { ok: true, publicKey: opts.publicKey ?? KEY },
    subscribe: async (body) => {
      posted.push(body)
      return opts.subscribe ?? { ok: true, count: 1 }
    },
  }
  return { value, posted }
}

// ---------------------------------------------------------------------------
// readPushState
// ---------------------------------------------------------------------------

test('no secure context: unsupported, and it says why — which is what pnpm dev shows', async () => {
  const state = await readPushState(browser({ secure: false }).env)
  assert.equal(state.kind, 'unsupported')
  assert.match(state.kind === 'unsupported' ? state.why : '', /secure/i)
})

test('no service worker or no PushManager: unsupported', async () => {
  assert.equal((await readPushState(browser({ worker: false }).env)).kind, 'unsupported')
  assert.equal((await readPushState(browser({ push: false }).env)).kind, 'unsupported')
})

test('permission denied reads as denied, subscribed reads as on, otherwise off', async () => {
  assert.equal((await readPushState(browser({ permission: 'denied' }).env)).kind, 'denied')
  assert.equal((await readPushState(browser({ permission: 'granted', existingKey: KEY }).env)).kind, 'on')
  assert.equal((await readPushState(browser({ permission: 'granted' }).env)).kind, 'off')
})

test('READING NEVER ASKS: readPushState does not request permission', async () => {
  // Asking on load is what browsers penalise, and it asks before the owner knows what for.
  let asked = 0
  const b = browser({})
  const env = { ...b.env, requestPermission: async () => (asked++, 'granted' as const) }
  await readPushState(env)
  assert.equal(asked, 0)
})

// ---------------------------------------------------------------------------
// enablePush — only ever from a click
// ---------------------------------------------------------------------------

test('enabling subscribes with the daemon’s key, posts it, and returns the count (criterion 54)', async () => {
  const b = browser({})
  const a = api({ subscribe: { ok: true, count: 2 } })

  const result = await enablePush(a.value, b.env)

  assert.deepEqual(result, { state: { kind: 'on' }, count: 2 })
  assert.deepEqual(b.subscribed, [KEY])
  assert.equal(a.posted.length, 1)
})

test('refusing the permission ends as denied, and nothing is posted', async () => {
  const b = browser({ grant: 'denied' })
  const a = api()

  const result = await enablePush(a.value, b.env)

  assert.equal(result.state.kind, 'denied')
  assert.equal(a.posted.length, 0)
})

test('an existing subscription made with ANOTHER key is replaced, not re-posted', async () => {
  // Re-posting it would store a device the push service answers 403 to for ever (spec A6).
  const b = browser({ permission: 'granted', existingKey: Buffer.from([0x04, ...Array(64).fill(9)]).toString('base64url') })
  const a = api()

  await enablePush(a.value, b.env)

  assert.deepEqual(b.subscribed, [KEY], 'a fresh subscription with the daemon’s key')
})

test('an existing subscription with the SAME key is reused, not duplicated', async () => {
  const b = browser({ permission: 'granted', existingKey: KEY })
  const a = api()

  await enablePush(a.value, b.env)

  assert.deepEqual(b.subscribed, [])
  assert.equal(a.posted.length, 1, 'posted again: the daemon may have been reset')
})

test('push off on the daemon: unsupported with the daemon’s message', async () => {
  const result = await enablePush(api({ publicKey: new Error('push is off on this machine') }).value, browser({}).env)
  assert.equal(result.state.kind, 'unsupported')
  assert.match(result.state.kind === 'unsupported' ? result.state.why : '', /push is off/)
})

test('a full cap comes back as an error carrying the daemon’s remedy (criteria 54, 57)', async () => {
  const a = api({ subscribe: { ok: false, status: 409, message: 'run `factotum push reset`' } })
  const result = await enablePush(a.value, browser({}).env)

  assert.equal(result.state.kind, 'off')
  assert.match(result.error ?? '', /factotum push reset/)
})

test('enablePush NEVER throws — a failure is a state, like main.tsx does with the worker', async () => {
  const b = browser({})
  const broken: PushEnvironment = { ...b.env, serviceWorkerReady: async () => { throw new Error('boom') } }

  const result = await enablePush(api().value, broken)

  assert.equal(result.state.kind, 'off')
  assert.match(result.error ?? '', /boom/)
})

// ---------------------------------------------------------------------------
// resubscribe — silent, at start (design D12)
// ---------------------------------------------------------------------------

test('RESUBSCRIBING NEVER ASKS and never creates: without a granted permission and a subscription, it does nothing', async () => {
  const asked: string[] = []
  const noPermission = browser({})
  const env = { ...noPermission.env, requestPermission: async () => (asked.push('asked'), 'granted' as const) }
  const a = api()

  assert.equal(await resubscribe(a.value, env), undefined)
  assert.equal(await resubscribe(a.value, browser({ permission: 'granted' }).env), undefined, 'granted but no subscription')
  assert.deepEqual(asked, [])
  assert.equal(a.posted.length, 0)
})

test('resubscribing re-posts the subscription this browser already has, and passes on what the daemon says', async () => {
  const b = browser({ permission: 'granted', existingKey: KEY })
  const a = api({ subscribe: { ok: true, count: 2, sameMachine: true } })

  const result = await resubscribe(a.value, b.env)

  assert.deepEqual(result, { state: { kind: 'on' }, count: 2, sameMachine: true })
  assert.equal(a.posted.length, 1)
  assert.deepEqual(b.subscribed, [], 'nothing new was created')
})

test('a daemon that does not say leaves sameMachine UNKNOWN, not false', async () => {
  const result = await resubscribe(api({ subscribe: { ok: true, count: 1 } }).value, browser({ permission: 'granted', existingKey: KEY }).env)
  assert.deepEqual(result, { state: { kind: 'on' }, count: 1 })
})
