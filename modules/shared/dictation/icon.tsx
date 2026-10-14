/**
 * The dictation's four glyphs (design D10). A COPY of the sessions module's paths — Phosphor Icons, MIT
 * (c) 2023 Phosphor Icons, @phosphor-icons/core 2.1.1, regular weight — because a shared folder
 * imports nothing from any module, not even a glyph (criterion 44). The originals stay where they are:
 * the sessions module uses them elsewhere.
 *
 * Decorative: a control that shows an icon alone carries its own label.
 */

const ICONS = {
  'microphone': 'M128,176a48,48,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48,48,0,0,0,128,176ZM96,64a32,32,0,0,1,64,0v64a32,32,0,0,1-64,0Zm40,143.6V240a8,8,0,0,1-16,0V207.6A80.1,80.1,0,0,1,48,128a8,8,0,0,1,16,0,64,64,0,0,0,128,0,8,8,0,0,1,16,0A80.1,80.1,0,0,1,136,207.6Z',
  'stop': 'M200,40H56A16,16,0,0,0,40,56V200a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Zm0,160H56V56H200V200Z',
  'circle-notch': 'M232,128a104,104,0,0,1-208,0c0-41,23.8-78.4,60.7-95.3a8,8,0,0,1,6.7,14.5C60.1,61.6,40,93.3,40,128a88,88,0,0,0,176,0c0-34.7-20.1-66.4-51.3-80.7a8,8,0,0,1,6.7-14.5C208.2,49.6,232,87,232,128Z',
  'warning': 'M236.8,188.1,149.3,36.2h0a24.8,24.8,0,0,0-42.7,0L19.2,188.1a23.5,23.5,0,0,0,0,23.7A24.4,24.4,0,0,0,40.5,224h174.9a24.4,24.4,0,0,0,21.3-12.2A23.5,23.5,0,0,0,236.8,188.1ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z',
} as const

export type DictationIcon = keyof typeof ICONS

export function Icon({ name, size = 20 }: { readonly name: DictationIcon; readonly size?: number }) {
  return (
    <svg class="icon" viewBox="0 0 256 256" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  )
}
