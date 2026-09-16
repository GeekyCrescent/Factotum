// Deliberately almost empty. It exists so the browser will offer to install, and so
// the secure context is provably real. Caching is the client spec's problem: a service
// worker that caches the wrong thing is how a PWA becomes unupdatable.
//
// NO `fetch` HANDLER, and that is measured rather than assumed. Chrome 153 on Android
// offered to install with this exact worker — a manifest with icons is what it wants;
// the `fetch` handler it used to require is not (spec 2026-09-15, A7). An empty
// `fetch` handler added "just in case" would put this worker in the path of every
// request for no behaviour at all.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
