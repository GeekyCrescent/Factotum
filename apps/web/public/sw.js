// Small on purpose. It exists so the browser will offer to install, so the secure context is
// provably real, and so the phone can be told something while the app is closed. Caching is the
// client spec's problem: a service worker that caches the wrong thing is how a PWA becomes
// unupdatable.
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
    })(),
  )
})

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
