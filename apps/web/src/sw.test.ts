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
}

async function worker(opts: { windows?: string[] } = {}) {
  const handlers = new Map<string, (event: unknown) => void>()
  const shown: Shown[] = []
  const opened: string[] = []
  const windows: FakeWindow[] = (opts.windows ?? []).map((url) => {
    const w: FakeWindow = {
      url,
      focused: false,
      navigatedTo: undefined,
      focus: async () => ((w.focused = true), w),
      navigate: async (to) => ((w.navigatedTo = to), w),
    }
    return w
  })

  const self = {
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
  return { handlers, shown, opened, windows, dispatch }
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
