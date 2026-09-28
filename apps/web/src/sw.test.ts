import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

/**
 * The service worker, EXECUTED — not grepped. `public/sw.js` is loaded into a sandbox with a fake
 * `self`, and real-shaped events are dispatched at it. A regex can say a listener exists; only
 * running it says what the listener does.
 */

const SW = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sw.js')
const ORIGIN = 'https://juans-macbook-pro.tailbd0167.ts.net:8443'

interface Shown {
  readonly title: string
  readonly options: { body?: string; tag?: string; data?: { path?: string }; actions?: unknown }
}

interface FakeWindow {
  readonly url: string
  focused: boolean
  navigatedTo: string | undefined
  focus: () => Promise<FakeWindow>
  navigate: (url: string) => Promise<FakeWindow>
  readonly messages: unknown[]
  readonly postMessage: (message: unknown) => void
}

interface StoredPending {
  readonly key: string
  readonly moduleId: string
  readonly tag: string
  readonly path: string
  readonly data: Record<string, unknown>
  readonly until: string
}

/** The store `sw.js` writes pendings to, faked in memory (design D7: `self.pendingStore`). */
function memoryStore(settings: { sameMachine?: boolean } = {}) {
  const rows = new Map<string, StoredPending>()
  return {
    rows,
    put: async (record: StoredPending) => void rows.set(record.key, record),
    settings: async () => settings,
  }
}

async function worker(opts: { windows?: string[]; store?: ReturnType<typeof memoryStore> } = {}) {
  const handlers = new Map<string, (event: unknown) => void>()
  const shown: Shown[] = []
  const opened: string[] = []
  const windows: FakeWindow[] = (opts.windows ?? []).map((url) => {
    const w: FakeWindow = {
      url,
      focused: false,
      navigatedTo: undefined,
      messages: [],
      postMessage: (message) => void w.messages.push(message),
      focus: async () => ((w.focused = true), w),
      navigate: async (to) => ((w.navigatedTo = to), w),
    }
    return w
  })

  const store = opts.store ?? memoryStore()
  const self = {
    pendingStore: store,
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
    skipWaiting: () => undefined,
    registration: { showNotification: async (title: string, options: Shown['options']) => void shown.push({ title, options }) },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow: async (url: string) => void opened.push(url),
    },
  }
  runInNewContext(await readFile(SW, 'utf8'), { self, URL })

  /** Dispatches and waits for everything handed to `waitUntil`, like the browser does. */
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = []
    handlers.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => void pending.push(p) })
    await Promise.all(pending)
    return pending.length
  }
  return { handlers, shown, opened, windows, dispatch, store }
}

const envelope = (message: Record<string, unknown>, machine = 'juans-macbook-pro', moduleId: string | null = 'sessions') => ({
  message: { title: 'finished', body: 'proyecto-a', path: '/m/sessions/019a', tag: '019a', ...message },
  moduleId,
  machine,
})

const pushEvent = (payload: unknown) => ({ data: { json: () => payload } })

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

test('a push is drawn from the payload alone, with the machine composed into the title', async () => {
  const w = await worker()
  await w.dispatch('push', pushEvent(envelope({})))

  assert.equal(w.shown.length, 1)
  assert.equal(w.shown[0]?.title, 'juans-macbook-pro: finished')
  assert.equal(w.shown[0]?.options.body, 'proyecto-a')
  assert.equal(w.shown[0]?.options.tag, '019a')
  assert.equal(w.shown[0]?.options.data?.path, '/m/sessions/019a')
})

test('everything goes through waitUntil — without it Chrome can kill the worker mid-notification', async () => {
  const w = await worker()
  assert.equal(await w.dispatch('push', pushEvent(envelope({}))), 1)
})

test('a push with an unreadable payload STILL shows something (userVisibleOnly is a promise)', async () => {
  // Subscribing with userVisibleOnly: true promises every push is visible. A push that shows
  // nothing gets a generic "updated in the background" from Chrome, and repeated, the
  // subscription is at risk.
  const w = await worker()
  await w.dispatch('push', { data: { json: () => { throw new SyntaxError('bad') } } })
  await w.dispatch('push', { data: null })

  assert.equal(w.shown.length, 2)
})

test('the daemon’s own notice (moduleId null) is drawn like any other (criterion 59)', async () => {
  const w = await worker()
  await w.dispatch('push', pushEvent(envelope({ title: 'new device', path: '/', tag: 'subscription' }, 'mimac', null)))
  assert.equal(w.shown[0]?.title, 'mimac: new device')
})

test('actions are passed through only when the message carries them', async () => {
  const w = await worker()
  await w.dispatch('push', pushEvent(envelope({})))
  await w.dispatch('push', pushEvent(envelope({ actions: [{ action: 'allow', label: 'Allow' }] })))

  assert.equal(w.shown[0]?.options.actions, undefined)
  assert.deepEqual(w.shown[1]?.options.actions, [{ action: 'allow', label: 'Allow' }])
})

// ---------------------------------------------------------------------------
// pendings (design D7, criterion 26)
// ---------------------------------------------------------------------------

const FUTURE = '2099-01-01T00:00:00.000Z'
const PAST = '2000-01-01T00:00:00.000Z'
const ask = (extra: Record<string, unknown> = {}) =>
  envelope({
    title: 'wants to write',
    path: '/m/sessions/019a?ask=TOKEN',
    tag: 'ask:TOKEN',
    data: { askId: 'TOKEN', sessionId: '019a', toolName: 'Write', file: 'a.txt' },
    until: FUTURE,
    ...extra,
  })

test('a notice with a future deadline is KEPT as pending, keyed by module and tag, with its path stripped of the query', async () => {
  const w = await worker({ store: memoryStore({ sameMachine: false }) })
  await w.dispatch('push', pushEvent(ask()))

  assert.equal(w.shown.length, 1, 'the notification is still drawn')
  // Through JSON: objects made inside the sandbox have the sandbox's prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify([...w.store.rows.values()])), [
    {
      key: 'sessions:ask:TOKEN',
      moduleId: 'sessions',
      tag: 'ask:TOKEN',
      path: '/m/sessions/019a',
      data: { askId: 'TOKEN', sessionId: '019a', toolName: 'Write', file: 'a.txt' },
      until: FUTURE,
    },
  ])
})

test('without a deadline, or with one already past, nothing is kept', async () => {
  const w = await worker({ store: memoryStore({ sameMachine: false }) })
  await w.dispatch('push', pushEvent(envelope({})))
  await w.dispatch('push', pushEvent(ask({ until: PAST })))
  await w.dispatch('push', pushEvent(ask({ until: 'not a date' })))
  assert.equal(w.store.rows.size, 0)
})

test('the same tag REPLACES the pending instead of adding another', async () => {
  const w = await worker({ store: memoryStore({ sameMachine: false }) })
  await w.dispatch('push', pushEvent(ask({ body: 'first' })))
  await w.dispatch('push', pushEvent(ask({ data: { askId: 'TOKEN', sessionId: '019a', file: 'b.txt' } })))
  assert.equal(w.store.rows.size, 1)
  assert.equal(w.store.rows.get('sessions:ask:TOKEN')?.data['file'], 'b.txt')
})

test('THE TOKEN IS KEPT ONLY WHEN THE DAEMON SAID THIS IS NOT ITS MACHINE: unknown counts as its machine (design D12)', async () => {
  for (const settings of [{ sameMachine: true }, {}]) {
    const w = await worker({ store: memoryStore(settings) })
    await w.dispatch('push', pushEvent(ask()))
    const row = w.store.rows.get('sessions:ask:TOKEN')
    assert.ok(row, `still pending with ${JSON.stringify(settings)}`)
    assert.equal('askId' in row.data, false, `no token with ${JSON.stringify(settings)}`)
    assert.equal(row.data['sessionId'], '019a')
  }
})

test('open windows are told a pending arrived, by key', async () => {
  const w = await worker({ windows: [`${ORIGIN}/m/example`], store: memoryStore({ sameMachine: false }) })
  await w.dispatch('push', pushEvent(ask()))
  assert.deepEqual(JSON.parse(JSON.stringify(w.windows[0]?.messages)), [{ type: 'pending', key: 'sessions:ask:TOKEN' }])
})

test('a notice without a module (the daemon’s own) is never a pending', async () => {
  const w = await worker({ store: memoryStore({ sameMachine: false }) })
  await w.dispatch('push', pushEvent(envelope({ until: FUTURE }, 'mimac', null)))
  assert.equal(w.store.rows.size, 0)
})

test('a store that fails still leaves the notification drawn', async () => {
  const broken = { ...memoryStore({ sameMachine: false }), put: async () => { throw new Error('quota') } }
  const w = await worker({ store: broken })
  await w.dispatch('push', pushEvent(ask()))
  assert.equal(w.shown.length, 1)
})

// ---------------------------------------------------------------------------
// notificationclick
// ---------------------------------------------------------------------------

const click = (path: unknown) => {
  let closed = false
  return {
    event: { notification: { data: { path }, close: () => void (closed = true) }, action: '' },
    closed: () => closed,
  }
}

test('a tap FOCUSES an open window of the app and navigates it — it does not open another', async () => {
  const w = await worker({ windows: [`${ORIGIN}/`] })
  const c = click('/m/sessions/019a?ask=token')

  await w.dispatch('notificationclick', c.event)

  assert.equal(w.windows[0]?.focused, true)
  assert.equal(w.windows[0]?.navigatedTo, `${ORIGIN}/m/sessions/019a?ask=token`)
  assert.deepEqual(w.opened, [])
  assert.equal(c.closed(), true)
})

test('with no window open, a tap opens one at the path, query included (criteria 30, 55)', async () => {
  const w = await worker()
  await w.dispatch('notificationclick', click('/m/sessions/019a?ask=token').event)
  assert.deepEqual(w.opened, [`${ORIGIN}/m/sessions/019a?ask=token`])
})

test('a path that is not same-origin is REFUSED and lands on the root instead', async () => {
  // `new URL('https://evil.example', origin)` resolves to evil.example, and so does a
  // protocol-relative `//evil.example`. The path comes from a payload; it is not trusted.
  for (const hostile of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)', 42, undefined]) {
    const w = await worker()
    await w.dispatch('notificationclick', click(hostile).event)
    assert.deepEqual(w.opened, [`${ORIGIN}/`], `for ${String(hostile)}`)
  }
})

test('a window of ANOTHER origin is not focused', async () => {
  const w = await worker({ windows: ['https://elsewhere.example/'] })
  await w.dispatch('notificationclick', click('/m/sessions/019a').event)

  assert.equal(w.windows[0]?.focused, false)
  assert.deepEqual(w.opened, [`${ORIGIN}/m/sessions/019a`])
})

test('the worker STILL has no fetch handler after all this', async () => {
  const w = await worker()
  assert.equal(w.handlers.has('fetch'), false)
  assert.equal(w.handlers.has('push'), true)
  assert.equal(w.handlers.has('notificationclick'), true)
})
