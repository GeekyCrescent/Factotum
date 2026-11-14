/**
 * The word diff of a rewritten item (spec 2026-11-12-postulaciones, requirements crit. 32; design
 * D15 «Reescrita»). Pure: the longest common subsequence over words, with the whitespace between them
 * as tokens of its own, so the parts joined back give each text exactly — line breaks included.
 *
 * Ties prefer keeping a token, then deleting before adding: a replaced word reads «old» struck through
 * and then «new», the way the mockup shows it.
 */

export interface DiffPart {
  readonly kind: 'same' | 'add' | 'del'
  readonly text: string
}

const tokens = (text: string): readonly string[] => text.match(/\s+|\S+/g) ?? []

/** `table[i][j]`: the LCS length of `a` from `i` and `b` from `j`. */
function suffixTable(a: readonly string[], b: readonly string[]): readonly (readonly number[])[] {
  const rows: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = rows[i] as number[]
    const below = rows[i + 1] as number[]
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number)
    }
  }
  return rows
}

function append(parts: readonly DiffPart[], kind: DiffPart['kind'], text: string): readonly DiffPart[] {
  const last = parts[parts.length - 1]
  if (last?.kind === kind) return [...parts.slice(0, -1), { kind, text: last.text + text }]
  return [...parts, { kind, text }]
}

export function wordDiff(before: string, after: string): readonly DiffPart[] {
  const a = tokens(before)
  const b = tokens(after)
  const table = suffixTable(a, b)
  const at = (i: number, j: number): number => table[i]?.[j] ?? 0
  let parts: readonly DiffPart[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      parts = append(parts, 'same', a[i] as string)
      i += 1
      j += 1
    } else if (i < a.length && (j >= b.length || at(i + 1, j) >= at(i, j + 1))) {
      parts = append(parts, 'del', a[i] as string)
      i += 1
    } else {
      parts = append(parts, 'add', b[j] as string)
      j += 1
    }
  }
  return parts
}

export function wordCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0
}

/** «212 → 158 words». */
export function countLine(before: string, after: string): string {
  const to = wordCount(after)
  return `${wordCount(before)} → ${to} ${to === 1 ? 'word' : 'words'}`
}
