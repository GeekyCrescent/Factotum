import { render } from 'preact'
import { Shell } from './shell.tsx'
import { takeLoad } from './use-route.ts'
import './styles/tokens.css'
import './styles/fonts.css'
import './styles/base.css'
import './styles/components.css'
import './styles/shell.css'

// The query leaves the address bar BEFORE the first render (spec 2026-09-18, §0.17): a screen that
// pushes a history entry later copies a URL that is already clean.
const initialSearch = takeLoad()
const root = document.getElementById('app')
if (root !== null) render(<Shell initialSearch={initialSearch} />, root)

/**
 * The service worker, and the two guards around it.
 *
 * `isSecureContext` is the one that matters: over plain HTTP —  `pnpm dev`, or the
 * bind when `tailscale serve` is not up — `register` rejects, and an unhandled
 * rejection on every load is how a console stops being worth reading. The secure
 * context is the whole point of the TLS spec, so asking for it directly says what
 * this depends on.
 *
 * A failure here is REPORTED AND SURVIVED, not thrown: the shell works without a
 * service worker; only installing does not.
 */
if (isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
    console.warn('service worker not registered; the app still works, installing may not', error)
  })
}
