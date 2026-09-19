/**
 * Draws one of the shell's glyphs. The paths live in `icons.ts` so a test can import them; this
 * only paints. Decorative by default: a control that shows an icon alone carries its own label.
 */

import { ICONS, type ShellIcon } from './icons.ts'

export function Icon({ name, size = 20 }: { readonly name: ShellIcon; readonly size?: number }) {
  return (
    <svg class="icon" viewBox="0 0 256 256" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  )
}
