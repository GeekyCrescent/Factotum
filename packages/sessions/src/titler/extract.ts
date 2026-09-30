/**
 * The titler's raw output → a title, or `null` (spec 2026-09-30, D5). Pure.
 *
 * `null` is an ordinary answer, not a failure: it means "leave the first line", and nothing is
 * written.
 */

import { TITLE_MAX } from '../history.ts'
import { NO_TITLE, TITLE_TAG } from './prompt.ts'

const TAGGED = new RegExp(`<${TITLE_TAG}>([\\s\\S]*?)</${TITLE_TAG}>`)

/** Quotes a model wraps a title in. A pair, one each side, and only as a pair. */
const WRAPPING = [
  ['"', '"'],
  ["'", "'"],
  ['«', '»'],
  ['“', '”'],
] as const

/** A final period or an ellipsis, with the spaces before it. */
const FINAL_DOTS = /\s*(?:\.{1,3}|…)$/

function unwrap(value: string): string {
  for (const [open, close] of WRAPPING) {
    if (value.length >= 2 && value.startsWith(open) && value.endsWith(close)) return value.slice(1, -1).trim()
  }
  return value
}

/**
 * Compared LOOSELY. "NO TITLE.", "No title…" and "Nó títle" all come out of a model with no
 * effort, and an exact comparison would store every one of them AS the conversation's title.
 */
function saysNoTitle(value: string): boolean {
  const plain = value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[\s.…!]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain === NO_TITLE.toLowerCase()
}

export function extractTitle(stdout: string): string | null {
  const found = TAGGED.exec(stdout)
  if (found === null) return null
  const title = unwrap(found[1]!.replace(/\s+/g, ' ').trim())
    .replace(FINAL_DOTS, '')
    .trim()
  if (title === '' || saysNoTitle(title)) return null
  return title.slice(0, TITLE_MAX).trim()
}
