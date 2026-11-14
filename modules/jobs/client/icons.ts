/**
 * The jobs screens' glyphs — their own, because a module imports nothing from the shell or another
 * module (design D15 «Estilo»).
 *
 * Phosphor Icons, MIT (c) 2023 Phosphor Icons — paths copied from @phosphor-icons/core 2.1.1, the same
 * ones the tasks and sessions modules carry, weight noted per glyph, coordinates rounded to one
 * decimal. Repeating them is the price of the dependency rule.
 *
 * Decorative: a control that shows an icon alone carries its own label.
 */

export const ICONS = {
  'x': 'M208.5,191.5a12,12,0,0,1-17,17L128,145,64.5,208.5a12,12,0,0,1-17-17L111,128,47.5,64.5a12,12,0,0,1,17-17L128,111l63.5-63.5a12,12,0,0,1,17,17L145,128Z', // bold
  'copy': 'M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z', // regular
  'warning': 'M236.8,188.1,149.3,36.2h0a24.8,24.8,0,0,0-42.7,0L19.2,188.1a23.5,23.5,0,0,0,0,23.7A24.4,24.4,0,0,0,40.5,224h174.9a24.4,24.4,0,0,0,21.3-12.2A23.5,23.5,0,0,0,236.8,188.1ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z', // fill
} as const

export type JobsIcon = keyof typeof ICONS
