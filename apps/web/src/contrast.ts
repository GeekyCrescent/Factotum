/**
 * WCAG contrast of the token pairs that matter, read from the CSS text of `styles/tokens.css`.
 *
 * Ported from the direction's `contrast.mjs` (design/, 2026-09-18) with the two changes that make
 * it able to fail (spec criterion 2):
 * - a token of a pair that cannot be read in a block THROWS, instead of the pair being skipped;
 * - it returns how many pairs it evaluated, so a test can demand all of them.
 *
 * Pure: it takes the CSS as a string, so the test decides where it comes from.
 */

export interface Pair {
  readonly fg: string
  readonly bg: string
  readonly min: number
  readonly what: string
}

/** The pairs of design/direccion-visual.md, the same sixteen for each mode. */
export const PAIRS: readonly Pair[] = [
  { fg: 'text', bg: 'bg', min: 4.5, what: 'body' },
  { fg: 'text-2', bg: 'bg', min: 4.5, what: 'secondary' },
  { fg: 'text-3', bg: 'bg', min: 4.5, what: 'tertiary / timestamps' },
  { fg: 'text-3', bg: 'surface', min: 4.5, what: 'tertiary on surface' },
  { fg: 'text-2', bg: 'surface', min: 4.5, what: 'secondary on surface' },
  { fg: 'accent-text', bg: 'bg', min: 4.5, what: 'accent text' },
  { fg: 'on-accent', bg: 'accent', min: 4.5, what: 'primary button label' },
  { fg: 'ask', bg: 'bg', min: 4.5, what: 'ask text' },
  { fg: 'ask', bg: 'ask-bg', min: 4.5, what: 'ask text on its tint' },
  { fg: 'text', bg: 'ask-bg', min: 4.5, what: 'body on ask tint' },
  { fg: 'text-2', bg: 'ask-bg', min: 4.5, what: 'secondary on ask tint' },
  { fg: 'ok', bg: 'bg', min: 4.5, what: 'success text' },
  { fg: 'err', bg: 'bg', min: 4.5, what: 'error text' },
  { fg: 'err', bg: 'err-bg', min: 4.5, what: 'error on its tint' },
  { fg: 'line-strong', bg: 'surface', min: 3, what: 'input border (1.4.11)' },
  { fg: 'line-strong', bg: 'bg', min: 3, what: 'control border (1.4.11)' },
]

export type Mode = 'light' | 'dark'
type Oklch = readonly [number, number, number]

export interface Result {
  readonly mode: Mode
  readonly pair: Pair
  readonly ratio: number
  readonly ok: boolean
}

const DARK = '@media (prefers-color-scheme: dark)'

/** `--name: oklch(L C H)` — bare numbers only. Any other form is NOT read, on purpose. */
function tokensIn(block: string): Map<string, Oklch> {
  const out = new Map<string, Oklch>()
  for (const m of block.matchAll(/--([\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/g)) {
    out.set(m[1] ?? '', [Number(m[2]), Number(m[3]), Number(m[4])])
  }
  return out
}

export function modesOf(css: string): Readonly<Record<Mode, Map<string, Oklch>>> {
  const at = css.indexOf(DARK)
  if (at < 0) throw new Error(`tokens.css has no ${DARK} block`)
  return { light: tokensIn(css.slice(0, at)), dark: tokensIn(css.slice(at)) }
}

function linear([L, C, H]: Oklch): [number, number, number] {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clip = (v: number) => Math.min(1, Math.max(0, v))
  return [
    clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

function luminance(c: Oklch): number {
  const [r, g, b] = linear(c)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function ratio(fg: Oklch, bg: Oklch): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Every pair in both modes. Throws on a token it cannot read: a skipped pair is a silent pass. */
export function measure(css: string): readonly Result[] {
  const modes = modesOf(css)
  const results: Result[] = []
  for (const mode of ['light', 'dark'] as const) {
    const tokens = modes[mode]
    for (const pair of PAIRS) {
      const fg = tokens.get(pair.fg)
      const bg = tokens.get(pair.bg)
      if (fg === undefined || bg === undefined) {
        throw new Error(`${mode}: cannot read --${fg === undefined ? pair.fg : pair.bg} as oklch(L C H)`)
      }
      const r = ratio(fg, bg)
      results.push({ mode, pair, ratio: r, ok: r >= pair.min })
    }
  }
  return results
}
