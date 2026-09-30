/**
 * Reading the references to uploads out of the owner's text. PURE.
 *
 * THE TEXT IS THE ONLY RECORD. The log gains no field (criterion 2): what was attached is what the
 * owner's message says, as whole lines of the form `@<root>/<uploadId>/<name>`. Everything here —
 * what a conversation owns when it is deleted, the name a conversation gets, what the titler and the
 * search see — is derived from those lines (spec 2026-10-01, D6, D7).
 *
 * A LINE ONLY COUNTS WITH THIS ROOT, EXACTLY, AND THE EXACT SHAPE. A path under another root, an id
 * that is not a UUIDv7, a name `sanitizeName` would change: none is a reference, and none can make a
 * delete reach anything.
 */

import { sep } from 'node:path'
import { isSessionId } from '../id.ts'
import type { SessionEvent } from '../types.ts'
import { isSanitizedName } from './name.ts'

export interface UploadRef {
  readonly uploadId: string
  readonly name: string
}

/** The reference a single line holds, if it is one. */
export function refOfLine(line: string, root: string): UploadRef | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('@')) return undefined
  const path = trimmed.slice(1)
  const prefix = root.endsWith(sep) ? root : root + sep
  if (!path.startsWith(prefix)) return undefined
  const parts = path.slice(prefix.length).split(sep)
  if (parts.length !== 2) return undefined
  const [uploadId, name] = parts as [string, string]
  if (!isSessionId(uploadId) || !isSanitizedName(name)) return undefined
  return { uploadId, name }
}

export function refsOf(text: string, root: string): readonly UploadRef[] {
  const refs: UploadRef[] = []
  for (const line of text.split('\n')) {
    const ref = refOfLine(line, root)
    if (ref !== undefined) refs.push(ref)
  }
  return refs
}

/**
 * The uploads a conversation OWNS: the ones in the owner's own messages. Not a path the agent read,
 * listed or quoted — those live in `tool`, `result` and assistant events, and deleting a conversation
 * must never reach an upload another one sent (criteria 33, 34).
 */
export function ownerUploadIds(events: readonly SessionEvent[], root: string): readonly string[] {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.kind !== 'message' || event.role !== 'user') continue
    for (const ref of refsOf(event.text, root)) ids.add(ref.uploadId)
  }
  return [...ids]
}

/** The text without its reference lines, and without the blank lines they leave at the end. */
export function stripRefs(text: string, root: string): string {
  return text
    .split('\n')
    .filter((line) => refOfLine(line, root) === undefined)
    .join('\n')
    .trimEnd()
}

/**
 * What the meta keeps as `prompt`, which names the conversation until a title exists: the words, and
 * when there are none, the names of the files — never a path (criterion 32).
 */
export function promptOf(text: string, root: string): string {
  const words = stripRefs(text, root).trim()
  if (words !== '') return words
  return refsOf(text, root)
    .map((ref) => ref.name)
    .join(', ')
}
