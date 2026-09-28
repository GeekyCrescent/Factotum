/**
 * What the agent writes, read as Markdown: blocks and inline spans, as data. Pure; no DOM
 * (guardrail 11). `markdown.tsx` paints it.
 *
 * NO HTML, ON PURPOSE. The text comes from the agent, which reads files nobody vetted, so it is
 * turned into nodes and never into `innerHTML`: a `<script>` in a message stays the characters
 * `<script>`. A link only becomes a link for http, https and mailto (`safeHref`).
 *
 * SMALL, ON PURPOSE. The subset the agent actually writes: headings, paragraphs, fenced code,
 * lists (nested by indent), quotes, rules, tables, and code, bold, italic and links inline. A
 * library that does all of CommonMark would weigh about half of the rest of the client.
 */

export type Inline =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'code'; readonly value: string }
  | { readonly kind: 'strong'; readonly children: readonly Inline[] }
  | { readonly kind: 'em'; readonly children: readonly Inline[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly Inline[] }

export interface ListItem {
  readonly children: readonly Inline[]
  readonly sub: List | undefined
}

export interface List {
  readonly kind: 'list'
  readonly ordered: boolean
  readonly start: number
  readonly items: readonly ListItem[]
}

export type Block =
  | { readonly kind: 'para'; readonly children: readonly Inline[] }
  | { readonly kind: 'heading'; readonly level: number; readonly children: readonly Inline[] }
  | { readonly kind: 'code'; readonly lang: string; readonly value: string }
  | { readonly kind: 'rule' }
  | { readonly kind: 'quote'; readonly children: readonly Block[] }
  | List
  | { readonly kind: 'table'; readonly head: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[] }

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

/**
 * One pass, left to right; the first alternative that matches at a place wins, so code comes
 * first (nothing inside it is markup) and bold before italic.
 *   1 code · 2 bold · 3 italic with * · 4 italic with _ (not inside a word) · 5,6 link · 7 bare URL
 */
const INLINE =
  /`([^`]+)`|\*\*(.+?)\*\*(?!\*)|\*(?![\s*])([^*]+?)\*|(?<![\p{L}\p{N}_])_(?![\s_])([^_]+?)_(?![\p{L}\p{N}_])|\[([^\]]+)\]\(([^)\s]*)\)|(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]])/gu

const SAFE_SCHEME = /^(https?:\/\/|mailto:)/i

export function safeHref(href: string): string | undefined {
  return SAFE_SCHEME.test(href) ? href : undefined
}

export function blocks(source: string): readonly Block[] {
  return parse(source.replace(/\r\n?/g, '\n').split('\n'))
}

export function inlines(source: string): readonly Inline[] {
  const out: Inline[] = []
  let at = 0
  for (const match of source.matchAll(INLINE)) {
    if (match.index > at) out.push(text(source.slice(at, match.index)))
    out.push(...span(match))
    at = match.index + match[0].length
  }
  if (at < source.length) out.push(text(source.slice(at)))
  return out
}

function text(value: string): Inline {
  return { kind: 'text', value }
}

function span(match: RegExpExecArray | RegExpMatchArray): readonly Inline[] {
  const [, code, strong, star, underscore, label, href, url] = match
  if (code !== undefined) return [{ kind: 'code', value: code }]
  if (strong !== undefined) return [{ kind: 'strong', children: inlines(strong) }]
  if (star !== undefined) return [{ kind: 'em', children: inlines(star) }]
  if (underscore !== undefined) return [{ kind: 'em', children: inlines(underscore) }]
  if (label !== undefined) {
    const safe = safeHref(href ?? '')
    return safe === undefined ? inlines(label) : [{ kind: 'link', href: safe, children: inlines(label) }]
  }
  return [{ kind: 'link', href: url ?? '', children: [text(url ?? '')] }]
}

// --- Blocks ----------------------------------------------------------------

/** A reader looks at line `at`: the block it makes and where the next one starts, or nothing. */
type Reader = (lines: readonly string[], at: number) => { readonly block: Block; readonly next: number } | undefined

function parse(lines: readonly string[]): Block[] {
  const out: Block[] = []
  let at = 0
  while (at < lines.length) {
    if ((lines[at] ?? '').trim() === '') {
      at += 1
      continue
    }
    const read = READERS.map((reader) => reader(lines, at)).find((found) => found !== undefined) ?? readPara(lines, at)
    out.push(read.block)
    at = read.next
  }
  return out
}

const readFence: Reader = (lines, at) => {
  const open = FENCE.exec(lines[at] ?? '')
  if (open === null) return undefined
  const marker = open[1] ?? '```'
  const body: string[] = []
  let next = at + 1
  while (next < lines.length && !(lines[next] ?? '').trim().startsWith(marker)) {
    body.push(lines[next] ?? '')
    next += 1
  }
  return { block: { kind: 'code', lang: open[2] ?? '', value: body.join('\n') }, next: next + 1 }
}

const readHeading: Reader = (lines, at) => {
  const found = HEADING.exec(lines[at] ?? '')
  if (found === null) return undefined
  return { block: { kind: 'heading', level: (found[1] ?? '#').length, children: inlines(found[2] ?? '') }, next: at + 1 }
}

const readRule: Reader = (lines, at) => (RULE.test(lines[at] ?? '') ? { block: { kind: 'rule' }, next: at + 1 } : undefined)

const readQuote: Reader = (lines, at) => {
  const inner: string[] = []
  let next = at
  for (let found = QUOTE.exec(lines[next] ?? ''); found !== null; found = QUOTE.exec(lines[next] ?? '')) {
    inner.push(found[1] ?? '')
    next += 1
  }
  return inner.length === 0 ? undefined : { block: { kind: 'quote', children: parse(inner) }, next }
}

const readTable: Reader = (lines, at) => {
  const head = lines[at] ?? ''
  const divider = lines[at + 1] ?? ''
  if (!head.includes('|') || !divider.includes('|') || !DIVIDER.test(divider)) return undefined
  const rows: (readonly Inline[])[][] = []
  let next = at + 2
  while (next < lines.length && (lines[next] ?? '').includes('|') && (lines[next] ?? '').trim() !== '') {
    rows.push(cells(lines[next] ?? ''))
    next += 1
  }
  return { block: { kind: 'table', head: cells(head), rows }, next }
}

function cells(line: string): (readonly Inline[])[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => inlines(cell.trim()))
}

interface RawItem {
  readonly indent: number
  readonly ordered: boolean
  readonly number: number
  readonly lines: string[]
}

function itemOf(line: string): RawItem | undefined {
  if (RULE.test(line)) return undefined
  const found = ITEM.exec(line)
  if (found === null) return undefined
  const marker = found[2] ?? '-'
  const ordered = /\d/.test(marker)
  return { indent: (found[1] ?? '').length, ordered, number: ordered ? Number.parseInt(marker, 10) : 1, lines: [found[3] ?? ''] }
}

/** Items, their indented continuation lines, and blank lines between items; anything else ends it. */
const readList: Reader = (lines, at) => {
  const raw: RawItem[] = []
  let next = at
  while (next < lines.length) {
    const line = lines[next] ?? ''
    const item = itemOf(line)
    const last = raw[raw.length - 1]
    const first = raw[0]
    // Bullets then numbers at the first item's level: a new list, not more of this one.
    if (item !== undefined && first !== undefined && item.indent <= first.indent && item.ordered !== first.ordered) break
    if (item !== undefined) raw.push(item)
    else if (line.trim() === '' && itemOf(lines[next + 1] ?? '') !== undefined && last !== undefined) {
      // A blank line between two items: the same list.
    } else if (/^\s+\S/.test(line) && last !== undefined) last.lines.push(line.trim())
    else break
    next += 1
  }
  return raw.length === 0 ? undefined : { block: nest(raw), next }
}

interface Draft {
  readonly indent: number
  readonly ordered: boolean
  readonly start: number
  readonly items: { children: readonly Inline[]; sub: Draft | undefined }[]
}

/** Deeper indent opens a list under the item before it; shallower goes back out to its level. */
function nest(raw: readonly RawItem[]): List {
  const draft = (item: RawItem): Draft => ({ indent: item.indent, ordered: item.ordered, start: item.number, items: [] })
  const root = draft(raw[0]!)
  const stack: Draft[] = [root]
  for (const item of raw) {
    while (stack.length > 1 && item.indent < stack[stack.length - 1]!.indent) stack.pop()
    const top = stack[stack.length - 1]!
    const parent = top.items[top.items.length - 1]
    if (item.indent > top.indent && parent !== undefined) {
      parent.sub ??= draft(item)
      stack.push(parent.sub)
    }
    stack[stack.length - 1]!.items.push({ children: inlines(item.lines.join('\n')), sub: undefined })
  }
  return finish(root)
}

function finish(draft: Draft): List {
  return {
    kind: 'list',
    ordered: draft.ordered,
    start: draft.start,
    items: draft.items.map((item) => ({ children: item.children, sub: item.sub === undefined ? undefined : finish(item.sub) })),
  }
}

/** A paragraph runs until a blank line or a line that starts another kind of block. */
function readPara(lines: readonly string[], at: number): { readonly block: Block; readonly next: number } {
  const body: string[] = [(lines[at] ?? '').trim()]
  let next = at + 1
  while (next < lines.length && (lines[next] ?? '').trim() !== '' && !interrupts(lines[next] ?? '')) {
    body.push((lines[next] ?? '').trim())
    next += 1
  }
  return { block: { kind: 'para', children: inlines(body.join('\n')) }, next }
}

function interrupts(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || itemOf(line) !== undefined
}

const READERS: readonly Reader[] = [readFence, readHeading, readRule, readQuote, readTable, readList]
