/**
 * Small markdown helpers shared by the seed parsers (kit and package). Pure.
 */

/** Any bracketed token, the linter's placeholder regex (design D6). */
export const BRACKET_TOKEN = /\[[^\]\n]{1,80}\]/g

const EMAIL_IN_TEXT = /[^\s@()<>,;:"'`*[\]]+@[^\s@()<>,;:"'`*[\]]+\.[a-z]{2,}/i

/** A numbered section heading, `## 7. Follow-up email`. */
const SECTION_HEADING = /^##\s+(\d+)\.\s+(.*)$/

export interface Section {
  readonly n: number
  readonly title: string
  readonly lines: readonly string[]
}

/** A `## ` heading that is not `## N. Title`: it and its lines are not read, so the report says so. */
export interface UnparsedHeading {
  readonly heading: string
  /** Its non-blank lines, without the `---` separators. */
  readonly lines: number
}

export interface Sections {
  readonly sections: readonly Section[]
  readonly unparsed: readonly UnparsedHeading[]
}

const isContentLine = (line: string): boolean => line.trim() !== '' && line.trim() !== '---'

/**
 * Splits a document into its `## N. Title` sections; each runs to the next `## ` heading. Any other
 * `## ` heading ends the section before it and is skipped with its lines, and listed in `unparsed`.
 */
export function splitSections(markdown: string): Sections {
  type Open = { readonly kind: 'section'; readonly section: Section & { lines: string[] } } | { readonly kind: 'unparsed'; readonly heading: string; readonly lines: string[] }
  const blocks: Open[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const heading = SECTION_HEADING.exec(line)
    if (heading) blocks.push({ kind: 'section', section: { n: Number(heading[1]), title: (heading[2] ?? '').trim(), lines: [] } })
    else if (line.startsWith('## ')) blocks.push({ kind: 'unparsed', heading: line.slice(3).trim(), lines: [] })
    else {
      const open = blocks.at(-1)
      if (open?.kind === 'section') open.section.lines.push(line)
      else open?.lines.push(line)
    }
  }
  return {
    sections: blocks.flatMap((b) => (b.kind === 'section' ? [b.section] : [])),
    unparsed: blocks.flatMap((b) => (b.kind === 'unparsed' ? [{ heading: b.heading, lines: b.lines.filter(isContentLine).length }] : [])),
  }
}

export const sectionsOf = (markdown: string): readonly Section[] => splitSections(markdown).sections

export const isCallout = (line: string): boolean => /^>\s*\[!/.test(line)

/**
 * The blockquote that starts at `lines[from]` (after skipping blank lines), without its `> `, or null if
 * the next non-blank line is not a blockquote or is a callout. Returns the text and the index after it.
 */
export function blockquoteAt(lines: readonly string[], from: number): { readonly text: string; readonly next: number } | null {
  let index = from
  while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1
  const first = lines[index]
  if (first === undefined || !first.startsWith('>') || isCallout(first)) return null
  const taken: string[] = []
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.startsWith('>') || isCallout(line)) break
    taken.push(line.replace(/^>\s?/, ''))
    index += 1
  }
  return { text: taken.join('\n').trim(), next: index }
}

export const firstEmail = (text: string): string | null => EMAIL_IN_TEXT.exec(text)?.[0] ?? null

/** Every email address in a text, with where it starts. */
export const emailsIn = (text: string): readonly { readonly email: string; readonly index: number }[] =>
  [...text.matchAll(new RegExp(EMAIL_IN_TEXT.source, 'gi'))].map((match) => ({ email: match[0], index: match.index }))

/** `Name · email · phone · LinkedIn`: three or more ` · ` parts, one of them an email address. */
export function isSignatureLine(line: string): boolean {
  const parts = line.split(' · ')
  return parts.length >= 3 && parts.some((part) => firstEmail(part) !== null)
}

/** Replaces every signature line with the `{signature}` slot (design D6 «Huecos», D8 step 5). */
export function slotSignature(text: string): { readonly text: string; readonly found: boolean } {
  let found = false
  const lines = text.split('\n').map((line) => {
    if (!isSignatureLine(line)) return line
    found = true
    return '{signature}'
  })
  return { text: lines.join('\n'), found }
}

export const bracketTokens = (text: string): readonly string[] => text.match(BRACKET_TOKEN) ?? []
