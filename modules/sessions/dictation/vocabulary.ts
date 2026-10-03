/**
 * The owner's terms → the `prompt` that biases the transcription (spec 2026-10-03, D5).
 *
 * A SHORT LIST WRITTEN BY HAND, never derived: six terms picked by hand did about five times better than
 * a whole catalogue in Jarvis, and the catalogue did as well as nothing.
 *
 * What does not fit goes WHOLE and FROM THE END: the owner writes first what they dictate most. The budget
 * keeps below where Whisper starts truncating on its own (`MAX_PROMPT_CHARS`).
 */

import { MAX_PROMPT_CHARS } from './shape.ts'

const SEPARATOR = ', '

export function buildPrompt(terms: readonly string[]): { readonly prompt: string; readonly dropped: number } {
  const kept: string[] = []
  let length = 0
  for (const term of terms) {
    const added = (kept.length === 0 ? 0 : SEPARATOR.length) + term.length
    if (length + added > MAX_PROMPT_CHARS) break
    kept.push(term)
    length += added
  }
  return { prompt: kept.join(SEPARATOR), dropped: terms.length - kept.length }
}
