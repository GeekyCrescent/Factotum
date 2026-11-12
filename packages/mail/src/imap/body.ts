/**
 * Which part of a mail is its text, and how that text is cut down (spec 2026-10-05, D5). Pure.
 *
 * NO HTML LIBRARY: the model tolerates imperfect text. What matters is not handing it a whole
 * newsletter's markup, and not handing it more than MAX_BODY_CHARS.
 */

import type { MessageStructureObject } from './client.ts'

export const MAX_BODY_CHARS = 4_000

export interface PickedPart {
  readonly part: string
  readonly kind: 'text' | 'html'
  /** The Content-Transfer-Encoding, lower case: `7bit`, `8bit`, `quoted-printable`, `base64`. */
  readonly encoding: string
  readonly charset: string
}

/**
 * The first `text/plain` leaf that is not an attachment; failing that, the first `text/html`.
 * `undefined` when there is neither — the mail is then classified by sender and subject.
 */
export function pickPart(structure: MessageStructureObject | undefined): PickedPart | undefined {
  if (structure === undefined) return undefined
  const leaves = leavesOf(structure).filter((leaf) => !isAttachment(leaf))
  const text = leaves.find((leaf) => leaf.type.toLowerCase() === 'text/plain')
  if (text !== undefined) return picked(text, 'text')
  const html = leaves.find((leaf) => leaf.type.toLowerCase() === 'text/html')
  if (html !== undefined) return picked(html, 'html')
  return undefined
}

/**
 * The raw bytes of a part — as `BODY.PEEK[n]` returns them, possibly cut — to text. The server sends
 * the transfer encoding as is, so it is undone here, and then the charset. An unknown charset reads
 * as UTF-8 rather than failing the mail: the model tolerates a wrong accent.
 */
export function decodePart(raw: Buffer, part: PickedPart): string {
  const bytes =
    part.encoding === 'base64'
      ? Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
      : part.encoding === 'quoted-printable'
        ? decodeQuotedPrintable(raw)
        : raw
  try {
    return new TextDecoder(part.charset).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** Counted, never downloaded (criterion 8). */
export function countAttachments(structure: MessageStructureObject | undefined): number {
  if (structure === undefined) return 0
  return leavesOf(structure).filter(isAttachment).length
}

/** HTML to text, then quoted lines out, blanks collapsed, and the cut with an ellipsis. */
export function plainText(raw: string, kind: 'text' | 'html'): string {
  const text = kind === 'html' ? htmlToText(raw) : raw
  const kept = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // What is quoted was already read, in the earlier mail it quotes (criterion 8).
    .filter((line) => !line.trimStart().startsWith('>'))
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return kept.length > MAX_BODY_CHARS ? `${kept.slice(0, MAX_BODY_CHARS - 1)}…` : kept
}

function leavesOf(node: MessageStructureObject): readonly MessageStructureObject[] {
  const children = node.childNodes ?? []
  if (children.length === 0) return [node]
  return children.flatMap(leavesOf)
}

function isAttachment(node: MessageStructureObject): boolean {
  return node.disposition?.toLowerCase() === 'attachment'
}

/** A single-part mail has no part number of its own: its body is section 1. */
function picked(node: MessageStructureObject, kind: 'text' | 'html'): PickedPart {
  return {
    part: node.part ?? '1',
    kind,
    encoding: (node.encoding ?? '7bit').toLowerCase(),
    charset: node.parameters?.charset ?? 'utf-8',
  }
}

/** RFC 2045 §6.7, on bytes: soft line breaks out, `=XX` to its byte. A cut `=X` at the end is dropped. */
function decodeQuotedPrintable(raw: Buffer): Buffer {
  const text = raw
    .toString('latin1')
    .replace(/=[0-9A-Fa-f]?$/, '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  return Buffer.from(text, 'latin1')
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => decodeEntity(whole, name))
}

function decodeEntity(whole: string, name: string): string {
  if (name.startsWith('#')) {
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  }
  return ENTITIES[name.toLowerCase()] ?? whole
}
