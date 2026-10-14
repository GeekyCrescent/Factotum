/**
 * The board's glyphs — its own, because a module imports nothing from the shell or another module.
 *
 * Phosphor Icons, MIT (c) 2023 Phosphor Icons — paths copied from @phosphor-icons/core 2.1.1, the same
 * ones the sessions module's glyph table carries, weights noted per glyph, coordinates rounded to one
 * decimal (spec 2026-09-18, criterion 30). Repeating them is the price of the dependency rule.
 *
 * Decorative: a control that shows an icon alone carries its own label.
 */

const ICONS = {
  'plus': 'M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z', // bold
  'x': 'M208.5,191.5a12,12,0,0,1-17,17L128,145,64.5,208.5a12,12,0,0,1-17-17L111,128,47.5,64.5a12,12,0,0,1,17-17L128,111l63.5-63.5a12,12,0,0,1,17,17L145,128Z', // bold
  'trash': 'M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z', // regular
  'square': 'M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32Zm0,176H48V48H208V208Z', // regular
  'check-square': 'M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32Zm-34.3,77.7-56,56a8,8,0,0,1-11.3,0l-24-24a8,8,0,0,1,11.3-11.3L112,148.7l50.3-50.3a8,8,0,0,1,11.3,11.3Z', // fill
  'dots-six-vertical': 'M108,60A16,16,0,1,1,92,44,16,16,0,0,1,108,60Zm56,16a16,16,0,1,0-16-16A16,16,0,0,0,164,76ZM92,112a16,16,0,1,0,16,16A16,16,0,0,0,92,112Zm72,0a16,16,0,1,0,16,16A16,16,0,0,0,164,112ZM92,180a16,16,0,1,0,16,16A16,16,0,0,0,92,180Zm72,0a16,16,0,1,0,16,16A16,16,0,0,0,164,180Z', // bold
  'warning': 'M236.8,188.1,149.3,36.2h0a24.8,24.8,0,0,0-42.7,0L19.2,188.1a23.5,23.5,0,0,0,0,23.7A24.4,24.4,0,0,0,40.5,224h174.9a24.4,24.4,0,0,0,21.3-12.2A23.5,23.5,0,0,0,236.8,188.1ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z', // fill
} as const

export type TasksIcon = keyof typeof ICONS

export function Icon({ name, size = 20, class: extra }: { readonly name: TasksIcon; readonly size?: number; readonly class?: string }) {
  return (
    <svg class={extra === undefined ? 'icon' : `icon ${extra}`} viewBox="0 0 256 256" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  )
}
