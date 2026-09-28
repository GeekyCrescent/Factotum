/**
 * The shell's glyphs, and what a module's `nav.icon` name resolves to.
 *
 * Phosphor Icons, MIT (c) 2023 Phosphor Icons — paths copied from @phosphor-icons/core 2.1.1,
 * weights noted per glyph, with every coordinate ROUNDED TO ONE DECIMAL: on a 256-unit grid drawn at
 * 20 px the difference is under a hundredth of a pixel, and it keeps the bundle under its ceiling
 * (spec 2026-09-18, criterion 30). Copied, not installed: a package for ~20 paths is the dependency this
 * project avoids (spec 2026-09-18, §3). A new glyph is copied the same way, from the same version.
 *
 * Data only, so `node --test` can import it; `icon.tsx` draws it.
 */

export const ICONS = {
  'list': 'M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128ZM40,72H216a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16ZM216,184H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z', // regular
  'x': 'M205.7,194.3a8,8,0,0,1-11.3,11.3L128,139.3,61.7,205.7a8,8,0,0,1-11.3-11.3L116.7,128,50.3,61.7A8,8,0,0,1,61.7,50.3L128,116.7l66.3-66.3a8,8,0,0,1,11.3,11.3L139.3,128Z', // regular
  'device-mobile': 'M176,16H80A24,24,0,0,0,56,40V216a24,24,0,0,0,24,24h96a24,24,0,0,0,24-24V40A24,24,0,0,0,176,16ZM72,64H184V192H72Zm8-32h96a8,8,0,0,1,8,8v8H72V40A8,8,0,0,1,80,32Zm96,192H80a8,8,0,0,1-8-8v-8H184v8A8,8,0,0,1,176,224Z', // regular
  'bell': 'M221.8,175.9C216.2,166.4,208,139.3,208,104a80,80,0,1,0-160,0c0,35.3-8.3,62.4-13.8,71.9A16,16,0,0,0,48,200H88.8a40,40,0,0,0,78.4,0H208a16,16,0,0,0,13.8-24.1ZM128,216a24,24,0,0,1-22.6-16h45.2A24,24,0,0,1,128,216ZM48,184c7.7-13.2,16-43.9,16-80a64,64,0,1,1,128,0c0,36,8.3,66.7,16,80Z', // regular
  'devices': 'M224,72H208V64a24,24,0,0,0-24-24H40A24,24,0,0,0,16,64v96a24,24,0,0,0,24,24H152v8a24,24,0,0,0,24,24h48a24,24,0,0,0,24-24V96A24,24,0,0,0,224,72ZM40,168a8,8,0,0,1-8-8V64a8,8,0,0,1,8-8H184a8,8,0,0,1,8,8v8H176a24,24,0,0,0-24,24v72Zm192,24a8,8,0,0,1-8,8H176a8,8,0,0,1-8-8V96a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8Zm-96,16a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h40A8,8,0,0,1,136,208Zm80-96a8,8,0,0,1-8,8H192a8,8,0,0,1,0-16h16A8,8,0,0,1,216,112Z', // regular
  'hard-drives': 'M208,136H48a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V152A16,16,0,0,0,208,136Zm0,64H48V152H208v48Zm0-160H48A16,16,0,0,0,32,56v48a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V56A16,16,0,0,0,208,40Zm0,64H48V56H208v48ZM192,80a12,12,0,1,1-12-12A12,12,0,0,1,192,80Zm0,96a12,12,0,1,1-12-12A12,12,0,0,1,192,176Z', // regular
  'plugs': 'M149.7,138.3a8,8,0,0,0-11.3,0L120,156.7,99.3,136l18.4-18.3a8,8,0,0,0-11.3-11.3L88,124.7,69.7,106.3a8,8,0,0,0-11.3,11.3L64.7,124,41.4,147.3a32,32,0,0,0,0,45.3l5.4,5.4-28.4,28.4a8,8,0,0,0,11.3,11.3l28.4-28.4,5.4,5.4a32,32,0,0,0,45.3,0L132,191.3l6.3,6.3a8,8,0,0,0,11.3-11.3L131.3,168l18.4-18.3A8,8,0,0,0,149.7,138.3Zm-52.3,65a16,16,0,0,1-22.6,0L52.7,181.2a16,16,0,0,1,0-22.6L76,135.3,120.7,180Zm140.3-185a8,8,0,0,0-11.3,0l-28.4,28.4-5.4-5.4a32,32,0,0,0-45.3,0L124,64.7l-6.3-6.3a8,8,0,0,0-11.3,11.3l80,80a8,8,0,0,0,11.3-11.3L191.3,132l23.3-23.3a32,32,0,0,0,0-45.3l-5.4-5.4,28.4-28.4A8,8,0,0,0,237.7,18.3Zm-34.4,79L180,120.7,135.3,76l23.3-23.3a16,16,0,0,1,22.6,0l22.1,22A16,16,0,0,1,203.3,97.4Z', // regular
  'arrow-clockwise': 'M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.8,71.6l-.2-.2a80,80,0,1,0-1.7,114.8,8,8,0,0,1,11,11.6A95.4,95.4,0,0,1,128,224h-1.3A96,96,0,1,1,195.8,60L224,85.8V56a8,8,0,1,1,16,0Z', // regular
  'terminal-window': 'M128,128a8,8,0,0,1-3,6.2l-40,32a8,8,0,1,1-10-12.5L107.2,128,75,102.2a8,8,0,1,1,10-12.5l40,32A8,8,0,0,1,128,128Zm48,24H136a8,8,0,0,0,0,16h40a8,8,0,0,0,0-16Zm56-96V200a16,16,0,0,1-16,16H40a16,16,0,0,1-16-16V56A16,16,0,0,1,40,40H216A16,16,0,0,1,232,56ZM216,200V56H40V200H216Z', // regular
  'circle': 'M128,24A104,104,0,1,0,232,128,104.1,104.1,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z', // regular
} as const

export type ShellIcon = keyof typeof ICONS

/**
 * A module declares `nav.icon` as a NAME (today "terminal", "dot"). The shell knows glyph names,
 * never module names, so this is an open vocabulary: an unknown name falls back to a circle.
 */
const NAV_ALIASES: Readonly<Record<string, ShellIcon>> = { terminal: 'terminal-window', dot: 'circle' }

export function navIcon(name: string | undefined): ShellIcon {
  if (name === undefined) return 'circle'
  if (Object.hasOwn(ICONS, name)) return name as ShellIcon
  return Object.hasOwn(NAV_ALIASES, name) ? (NAV_ALIASES[name] as ShellIcon) : 'circle'
}
