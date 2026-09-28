// Small on purpose. It exists so the browser will offer to install, so the secure context is
// provably real, and so the phone can be told something while the app is closed. It caches
// nothing: a service worker that caches the wrong thing is how a PWA becomes unupdatable.
//
// IT KEEPS ONE THING: what is PENDING (spec 2026-09-18, design D7). A notice with a deadline
// (`message.until`) is stored in IndexedDB so the app can list it and answer it without the
// notification. The window reads the same store (apps/web/src/pending-db.ts, which cannot be
// imported here: if the schema changes on one side, it changes on the other).
//
// NO `fetch` HANDLER, and that is measured rather than assumed. Chrome 153 on Android
// offered to install with this worker when it had only `install` and `activate` — a manifest
// with icons is what it wants; the `fetch` handler it used to require is not (spec
// 2026-09-15, A7). An empty `fetch` handler added "just in case" would put this worker in the
// path of every request for no behaviour at all.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// A notice from the daemon. The payload is a PushEnvelope: { message, moduleId, machine }.
//
// DRAWN FROM THE PAYLOAD ALONE — no call back to the daemon, which may be exactly what is down.
// EVERYTHING INSIDE waitUntil, or Chrome may stop the worker half way through.
// ALWAYS SHOWS SOMETHING: the subscription promised `userVisibleOnly`, and a push that draws
// nothing earns a generic "updated in the background" from Chrome and puts the subscription at
// risk.
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let envelope
      try {
        envelope = event.data ? event.data.json() : undefined
      } catch {
        envelope = undefined
      }

      const message = envelope && envelope.message
      if (!message || typeof message.title !== 'string') {
        await self.registration.showNotification('factotum', { body: 'Something needs your attention.' })
        return
      }

      // The title is composed HERE, so neither the kernel nor a module rewrites text it does not
      // own (spec D1 bis). The machine is what tells two daemons' notices apart.
      const title = envelope.machine ? `${envelope.machine}: ${message.title}` : message.title
      const options = {
        body: message.body,
        tag: message.tag,
        data: Object.assign({}, message.data, { path: message.path }),
      }
      if (Array.isArray(message.actions)) options.actions = message.actions
      await self.registration.showNotification(title, options)
      await keepPending(envelope.moduleId, message)
    })(),
  )
})

// AFTER the notification is drawn, so a store that fails never costs the owner the notice.
// NO CONSOLE: the record may hold an ask token (ADR-0010); a failure means the pending does not
// show in the app, and the notification is still the way to answer.
async function keepPending(moduleId, message) {
  const until = Date.parse(message.until)
  if (typeof moduleId !== 'string' || typeof message.tag !== 'string' || !(until > Date.now())) return
  try {
    const store = self.pendingStore || indexedDbStore()
    const settings = await store.settings()
    const data = Object.assign({}, message.data)
    // The token stays on the device ONLY when the daemon said this is not its machine. Unknown
    // counts as its machine: the safe side (design D12).
    if (settings.sameMachine !== false) delete data.askId
    const path = typeof message.path === 'string' ? message.path.split('?')[0] : '/'
    const key = `${moduleId}:${message.tag}`
    await store.put({ key, moduleId, tag: message.tag, path, data, until: message.until })
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) client.postMessage({ type: 'pending', key })
  } catch {
    // Nothing to do; see above.
  }
}

// Base `factotum`, stores `pending` (key `key`) and `settings` (one record, key `device`).
function indexedDbStore() {
  const open = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open('factotum', 1)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'key' })
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  const run = async (name, mode, work) => {
    const db = await open()
    try {
      return await new Promise((resolve, reject) => {
        const request = work(db.transaction(name, mode).objectStore(name))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  }
  return {
    put: (record) => run('pending', 'readwrite', (s) => s.put(record)),
    settings: async () => {
      const value = await run('settings', 'readonly', (s) => s.get('device'))
      return value && typeof value === 'object' ? value : {}
    },
  }
}

// A tap. FOCUS an open window of the app before opening another — opening every time is how a
// PWA piles up windows.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = sameOriginTarget(event.notification.data && event.notification.data.path)

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        await client.focus()
        if (typeof client.navigate === 'function') await client.navigate(target)
        return
      }
      await self.clients.openWindow(target)
    })(),
  )
})

// The path comes from a push payload, so it is not trusted. Only a same-origin path is followed:
// `new URL('https://evil.example', origin)` resolves to evil.example, and so does `//evil.example`.
// Anything else lands on the root.
function sameOriginTarget(path) {
  const root = `${self.location.origin}/`
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return root
  try {
    const url = new URL(path, self.location.origin)
    return url.origin === self.location.origin ? url.href : root
  } catch {
    return root
  }
}
