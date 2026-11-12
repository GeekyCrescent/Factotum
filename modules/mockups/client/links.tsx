/**
 * The mockup's deployments (criteria 32, 33, 34): the build's preview, opened from its gate on the
 * phone, and production once delivered. Only an `https:` URL becomes a link (`safeUrl`).
 */

import { Icon } from './icon.tsx'
import { safeUrl } from './model.ts'

export function OpenUrl({ label, url, primary = false }: { readonly label: string; readonly url: string | undefined; readonly primary?: boolean }) {
  const href = safeUrl(url)
  if (href === undefined) return null
  return (
    <a class={`btn mk-big${primary ? ' primary' : ''}`} href={href} target="_blank" rel="noopener noreferrer">
      <Icon name="arrow-square-out" size={16} /> {label}
    </a>
  )
}

export function Deployments({ urls }: { readonly urls: { readonly preview?: string; readonly prod?: string } }) {
  const preview = safeUrl(urls.preview)
  const prod = safeUrl(urls.prod)
  if (preview === undefined && prod === undefined) return null
  return (
    <section class="mk-project">
      <h3 class="mk-h3">Deployments</h3>
      {[
        ['Production', prod],
        ['Preview', preview],
      ].map(([label, href]) =>
        href === undefined ? null : (
          <p key={label} class="mk-small">
            {label}:{' '}
            <a class="mk-mono mk-ellipsis" href={href} target="_blank" rel="noopener noreferrer">
              {href}
            </a>
          </p>
        ),
      )}
    </section>
  )
}
