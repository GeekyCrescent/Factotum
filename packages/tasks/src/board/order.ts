/**
 * The order of the cards inside a column: a text key between its two neighbours (design D3).
 *
 * FRACTIONAL INDEXING in base 62, the midpoint of rocicorp's `fractional-indexing` without its
 * integer part. A key is the digits after the point of a number in (0, 1); the digits are in ASCII
 * order, so comparing two keys as plain text (`<`, never `localeCompare`) compares the numbers.
 * Moving a card writes ONE key; its neighbours keep theirs.
 *
 * A KEY NEVER ENDS IN `0`: `a0` is the same number as `a`, and there would be no room between them.
 *
 * THE GAP RUNS OUT. Inserting again and again into the same place grows the key by about one
 * character every six times. Past MAX_KEY_CHARS the whole column is renumbered with short keys of
 * one length, in the same write — rare, and the cost of keeping each move to one key.
 */

export const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const MAX_KEY_CHARS = 64

const BASE = DIGITS.length
const VALID_KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/

function digitOf(char: string | undefined): number {
  return char === undefined ? 0 : DIGITS.indexOf(char)
}

/** `a` is `''` at the start of the column; `b` is `null` at its end. */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // The shared prefix stays; the midpoint is of what follows it.
    let n = 0
    while ((a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const low = digitOf(a[0])
  const high = b === null ? BASE : digitOf(b[0])
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)] as string
  // Adjacent first digits: `b` cut to its first digit is between, if `b` has more after it.
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return (DIGITS[low] as string) + midpoint(a.slice(1), null)
}

export function keyBetween(a: string, b: string | null): string {
  if (a !== '' && !VALID_KEY.test(a)) throw new Error('not an order key')
  if (b !== null && !VALID_KEY.test(b)) throw new Error('not an order key')
  if (b !== null && a >= b) throw new Error('order keys out of order')
  return midpoint(a, b)
}

/** `n` keys of one short length, spread evenly over the range. */
export function renumber(n: number): readonly string[] {
  let length = 1
  while (BASE ** length < 2 * (n + 1)) length++
  const span = BASE ** length
  return Array.from({ length: n }, (_, i) => {
    let value = Math.floor(((i + 1) * span) / (n + 1))
    let key = ''
    for (let place = 0; place < length; place++) {
      key = (DIGITS[value % BASE] as string) + key
      value = Math.floor(value / BASE)
    }
    return key.replace(/0+$/, '')
  })
}

/**
 * The keys of a column after a card is inserted at `index`: the same keys with one new one, or —
 * when the gap is spent or the column was already broken — the whole column renumbered.
 */
export function insertAt(keys: readonly string[], index: number): readonly string[] {
  const at = Math.min(Math.max(index, 0), keys.length)
  const before = at === 0 ? '' : (keys[at - 1] as string)
  const after = at === keys.length ? null : (keys[at] as string)
  let key: string
  try {
    key = keyBetween(before, after)
  } catch {
    return renumber(keys.length + 1)
  }
  if (key.length > MAX_KEY_CHARS) return renumber(keys.length + 1)
  return [...keys.slice(0, at), key, ...keys.slice(at)]
}
