/**
 * Draws one of this module's glyphs. The paths live in `icons.ts` so a test can import them; this
 * only paints. Decorative: a control that shows an icon alone carries its own label.
 */

import { ICONS, type SessionIcon } from './icons.ts'

export function Icon({ name, size = 20 }: { readonly name: SessionIcon; readonly size?: number }) {
  return (
    <svg class="icon" viewBox="0 0 256 256" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  )
}
