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

/** One part per token, unmerged: the walk of the LCS table. */
function tokenOps(before: string, after: string): readonly DiffPart[] {
  const a = tokens(before)
  const b = tokens(after)
  const table = suffixTable(a, b)
  const at = (i: number, j: number): number => table[i]?.[j] ?? 0
  const ops: DiffPart[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i] as string })
      i += 1
      j += 1
    } else if (i < a.length && (j >= b.length || at(i + 1, j) >= at(i, j + 1))) {
      ops.push({ kind: 'del', text: a[i] as string })
      i += 1
    } else {
      ops.push({ kind: 'add', text: b[j] as string })
      j += 1
    }
  }
  return ops
}

const merged = (parts: readonly DiffPart[]): readonly DiffPart[] =>
  parts.reduce<readonly DiffPart[]>((done, part) => (part.text === '' ? done : append(done, part.kind, part.text)), [])

/** The exact diff: same+add joined is `after`, same+del joined is `before`. */
export function wordDiff(before: string, after: string): readonly DiffPart[] {
  return merged(tokenOps(before, after))
}

const isSpace = (token: string): boolean => /^\s+$/.test(token)
const leading = (text: string): string => /^\s*/.exec(text)?.[0] ?? ''
const trailing = (text: string): string => /\s*$/.exec(text)?.[0] ?? ''

/** Where the change starting at `start` ends (exclusive): changes joined by the spaces between them. */
function changeEnd(ops: readonly DiffPart[], start: number): number {
  let end = start + 1
  for (;;) {
    const next = ops[end]
    if (next === undefined) return end
    if (next.kind !== 'same') end += 1
    else if (isSpace(next.text) && ops[end + 1] !== undefined && ops[end + 1]?.kind !== 'same') end += 2
    else return end
  }
}

/**
 * One change as drawn: everything struck, a space, everything added — the layout (line breaks) of the
 * new text around it, or of the old one when the new has none.
 */
function changeParts(change: readonly DiffPart[]): readonly DiffPart[] {
  const oldRaw = change.filter((op) => op.kind !== 'add').map((op) => op.text).join('')
  const newRaw = change.filter((op) => op.kind !== 'del').map((op) => op.text).join('')
  const removed = oldRaw.trim()
  const added = newRaw.trim()
  if (removed === '' && added === '') return [{ kind: 'same', text: newRaw === '' ? oldRaw : newRaw }]
  return [
    { kind: 'same', text: leading(newRaw) || leading(oldRaw) },
    { kind: 'del', text: removed },
    { kind: 'same', text: removed !== '' && added !== '' ? ' ' : '' },
    { kind: 'add', text: added },
    { kind: 'same', text: trailing(newRaw) || trailing(oldRaw) },
  ]
}

/** A space between any two parts that would otherwise meet word to word. */
function spaced(parts: readonly DiffPart[]): readonly DiffPart[] {
  return parts.flatMap((part, at) => {
    const left = parts[at - 1]
    const touches = left !== undefined && /\S$/.test(left.text) && /^\S/.test(part.text)
    return touches ? [{ kind: 'same', text: ' ' } as const, part] : [part]
  })
}

/**
 * The diff as the card draws it (design D15): each change is the struck old run, a space, the added
 * run, and no two words of neighbouring parts ever touch — the whitespace the exact diff spends on
 * keeping both texts whole is not what a reader needs. Spacing aside, dropping the `del` parts still
 * reads the new text, and dropping the `add` parts the old one.
 */
export function diffParts(before: string, after: string): readonly DiffPart[] {
  const ops = tokenOps(before, after)
  const drawn: DiffPart[] = []
  let at = 0
  while (at < ops.length) {
    const op = ops[at] as DiffPart
    if (op.kind === 'same') {
      drawn.push(op)
      at += 1
    } else {
      const end = changeEnd(ops, at)
      drawn.push(...changeParts(ops.slice(at, end)))
      at = end
    }
  }
  return merged(spaced(merged(drawn)))
}

export function wordCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0
}

/** «212 → 158 words». */
export function countLine(before: string, after: string): string {
  const to = wordCount(after)
  return `${wordCount(before)} → ${to} ${to === 1 ? 'word' : 'words'}`
}
