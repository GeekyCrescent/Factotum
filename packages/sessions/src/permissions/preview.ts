/**
 * What an ask is about to write, cut to a size the approval panel can show.
 *
 * Only the four WRITING_TOOLS reach an ask (`decide.ts`); `Bash` never does — it is the declared
 * hole, not a writer here — so it has no preview and never will from this function.
 *
 * THE BEGINNING AND THE END, never just the beginning. An agent that wants to hide what it writes
 * can pad the start; the panel shows both ends and says how much it left out, so padding has
 * nowhere to hide the last thing written.
 *
 * Kept in memory with the ask, like its target (spec D8). It never goes into the push, which
 * leaves the tailnet.
 */

import type { AskPreview } from '../types.ts'

export type { AskPreview }

export const HEAD_CHARS = 1_500
export const TAIL_CHARS = 500

function textOf(toolName: string, input: Record<string, unknown>): { readonly text: string; readonly edits: number | null } | null {
  switch (toolName) {
    case 'Write':
      return typeof input['content'] === 'string' ? { text: input['content'], edits: null } : null
    case 'Edit':
      return typeof input['new_string'] === 'string' ? { text: input['new_string'], edits: null } : null
    case 'NotebookEdit':
      return typeof input['new_source'] === 'string' ? { text: input['new_source'], edits: null } : null
    case 'MultiEdit': {
      const edits = input['edits']
      if (!Array.isArray(edits)) return null
      const parts = edits.map((edit: unknown) =>
        edit !== null && typeof edit === 'object' ? (edit as Record<string, unknown>)['new_string'] : undefined,
      )
      if (!parts.every((part): part is string => typeof part === 'string')) return null
      return { text: parts.join('\n\n'), edits: parts.length }
    }
    default:
      return null
  }
}

export function previewOf(toolName: string, toolInput: unknown): AskPreview | null {
  if (toolInput === null || typeof toolInput !== 'object') return null
  const found = textOf(toolName, toolInput as Record<string, unknown>)
  if (found === null) return null
  const { text, edits } = found
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return { head: text, tail: '', total: text.length, edits }
  return { head: text.slice(0, HEAD_CHARS), tail: text.slice(text.length - TAIL_CHARS), total: text.length, edits }
}
