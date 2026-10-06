/**
 * The inbox screen's four glyphs — its own, because a module imports nothing from the shell.
 *
 * Phosphor Icons, MIT (c) 2023 Phosphor Icons — paths copied from @phosphor-icons/core 2.1.1, the same
 * ones `modules/sessions/client/icons.ts` and `apps/web/src/icons.ts` carry, weights noted per glyph,
 * coordinates rounded to one decimal (spec 2026-09-18, criterion 30). Repeating them is the price of
 * the dependency rule, not an oversight.
 *
 * Decorative: a control that shows an icon alone carries its own label.
 */

const ICONS = {
  'copy': 'M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z', // regular
  'check': 'M232.5,80.5l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.5,63.5a12,12,0,0,1,17,17Z', // bold
  'caret-down': 'M213.7,101.7l-80,80a8,8,0,0,1-11.3,0l-80-80A8,8,0,0,1,53.7,90.3L128,164.7l74.3-74.3a8,8,0,0,1,11.3,11.3Z', // regular
  'envelope-simple': 'M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM203.4,64,128,133.2,52.6,64ZM216,192H40V74.2l82.6,75.7a8,8,0,0,0,10.8,0L216,74.2V192Z', // regular
} as const

export type InboxIcon = keyof typeof ICONS

export function Icon({ name, size = 20, class: extra }: { readonly name: InboxIcon; readonly size?: number; readonly class?: string }) {
  return (
    <svg class={extra === undefined ? 'icon' : `icon ${extra}`} viewBox="0 0 256 256" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  )
}
