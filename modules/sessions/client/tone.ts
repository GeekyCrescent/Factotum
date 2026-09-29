/**
 * Each project's colour: the one the owner picked (spec 2026-09-29, criterion 26), else one of
 * PROJECT_TONES picked from its id, so a site keeps its colour on every screen and every device
 * without anything stored. Pure; no DOM (guardrail 11).
 *
 * The colours themselves are `--p1`…`--p6` in tokens.css; `client.css` turns `s-p<n>` into them.
 */

export const PROJECT_TONES = 6

/** FNV-1a over the name's UTF-16 units: cheap, and a one-letter change moves the result. */
export function toneOf(site: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < site.length; i++) {
    hash ^= site.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash % PROJECT_TONES) + 1
}

/** The class that sets `--project` and `--project-soft` for everything inside it. */
export function toneClass(site: string, color?: number | undefined): string {
  return `s-p${color !== undefined && Number.isInteger(color) && color >= 1 && color <= PROJECT_TONES ? color : toneOf(site)}`
}
