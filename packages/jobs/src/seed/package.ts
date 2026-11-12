/**
 * The application package of the seed (`02-…`, `03-…`, `04-…`) → entries (design D8 step 4). Pure.
 *
 * One parser for the three shapes of requirements §0.9: the ads (a `**Cover letter**` heading and
 * `**Likely form questions**`), wave 1 (the email body right after the bullets, the signature inside)
 * and wave 2 (the signature once at the top of the file). The types are shaped after design D3 so they
 * can move into `types.ts` later.
 */

import { resolveFormAnswer, type Kit, type KitRefResult } from './kit.ts'
import { blockquoteAt, firstEmail, sectionsOf } from './markdown.ts'

export type Channel = 'email' | 'form' | 'platform' | 'linkedin'

export interface Target {
  readonly to: string | null
  readonly url: string | null
  /** The text of the primary destination of a `linkedin` entry (design D3 `target.instruction`). */
  readonly instruction: string | null
}

export interface FormAnswer {
  readonly question: string
  readonly answer: string
  readonly hint: string | null
}

export interface Skills {
  readonly tick: readonly string[]
  readonly doNotTick: readonly string[]
}

export interface PackageKitRef extends KitRefResult {
  readonly question: string
}

export interface PackageEntry {
  readonly n: number
  readonly company: string
  readonly channel: Channel
  readonly target: Target
  /** The raw `Send via` value, for the report and the owner. */
  readonly sendVia: string | null
  readonly contact: string | null
  readonly role: string | null
  readonly cvBase: 'A' | 'B' | null
  readonly adStatus: string | null
  readonly letter: { readonly subject: string | null; readonly body: string } | null
  readonly form: readonly FormAnswer[]
  readonly skills: Skills | null
  readonly linkedin: string | null
  /** «Owner notes»: never sent, so placeholders stay as they are. */
  readonly notes: string
  readonly kitRefs: readonly PackageKitRef[]
  /** The fields the entry lacks, for the report (`{ file, n, missing }`). */
  readonly missing: readonly string[]
}

export interface PackageFile {
  readonly file: string
  readonly entries: readonly PackageEntry[]
}

const URL_IN_TEXT = /https?:\/\/[^\s()<>"'`*]+/i
const PORTFOLIO_TODO = /`?\[[^\]\n]*portfolio[^\]\n]*\bTODO\b[^\]\n]*\]`?/gi
const BODY_HEADING = /^\*\*(cover letter|profile summary|expression-of-interest email)\b/i
const FIELD = /\*\*([^*]+?):\*\*\s*/g

const firstUrl = (text: string): string | null => URL_IN_TEXT.exec(text)?.[0].replace(/[.,;:]+$/, '') ?? null
const slotPortfolio = (text: string): string => text.replace(PORTFOLIO_TODO, '{portfolio}')

/** The first run of `- **…` bullets of an entry (its fields), as `[start, end)`; owner-note bullets come later. */
function headBullets(lines: readonly string[]): readonly [number, number] {
  const start = lines.findIndex((line) => line.startsWith('- **'))
  if (start === -1) return [-1, -1]
  const length = lines.slice(start).findIndex((line) => !line.startsWith('- '))
  return [start, length === -1 ? lines.length : start + length]
}

/** The `- **Key:** value · **Key:** value` bullets of an entry → `key → value` (keys lowercased, without their parenthesis). */
function fieldsOf(lines: readonly string[]): ReadonlyMap<string, string> {
  const fields = new Map<string, string>()
  const [start, end] = headBullets(lines)
  for (const line of lines.slice(Math.max(start, 0), Math.max(end, 0))) {
    const keys = [...line.matchAll(FIELD)]
    keys.forEach((match, index) => {
      const next = keys[index + 1]
      const end = next === undefined ? line.length : next.index
      const value = line.slice(match.index + match[0].length, end).replace(/\s·\s*$/, '').trim()
      const key = (match[1] ?? '').replace(/\([^)]*\)/g, '').trim().toLowerCase()
      if (!fields.has(key)) fields.set(key, value)
    })
  }
  return fields
}

/**
 * The channel and target of the PRIMARY destination of `Send via` (design D8 step 4): LinkedIn first →
 * `linkedin`; SEEK → `platform`; an email address (or an `email to …` with a placeholder) → `email`;
 * anything else (an ATS, a form, a careers or contact page) → `form`.
 */
export function channelOf(primary: string): { readonly channel: Channel; readonly target: Target } {
  const text = primary.trim()
  if (/^seek\b/i.test(text)) return { channel: 'platform', target: { to: null, url: firstUrl(text), instruction: null } }
  const address = text.replace(/^email\s+(to\s+)?/i, '')
  const email = firstEmail(address)
  if (email !== null && address.startsWith(email)) return { channel: 'email', target: { to: email, url: null, instruction: null } }
  if (/^email\b/i.test(text)) {
    const placeholder = /\*\*(\[[^\]\n]+\])\*\*/.exec(text)?.[1] ?? null
    return { channel: 'email', target: { to: email ?? placeholder, url: null, instruction: null } }
  }
  return { channel: 'form', target: { to: null, url: firstUrl(text), instruction: null } }
}

const SEPARATORS = [' · ', ';', ', plus ', ' plus ', ', then ', ' then ', ', otherwise ', ' otherwise ', ', or ', ' or ', ' and ']

/** Splits `Send via` into its destinations, outside parentheses and brackets (design D8 step 4). */
export function splitSendVia(value: string): readonly string[] {
  const text = value.replace(/\*\*and\*\*/g, 'and').replace(/\s\(cc\s+([^)]*)\)/g, ' · cc $1')
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(' || char === '[') depth += 1
    if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    if (depth > 0) continue
    const separator = SEPARATORS.find((candidate) => text.startsWith(candidate, index))
    if (separator === undefined) continue
    parts.push(text.slice(start, index))
    start = index + separator.length
    index = start - 1
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/** The lines after a bold heading line, up to the next bold heading or the end. */
function blockAfter(lines: readonly string[], heading: RegExp): readonly string[] | null {
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return null
  const after = lines.slice(start + 1)
  const stop = after.findIndex((line) => line.startsWith('**'))
  return stop === -1 ? after : after.slice(0, stop)
}

function bodyOf(lines: readonly string[]): string | null {
  const heading = lines.findIndex((line) => BODY_HEADING.test(line))
  if (heading !== -1) return blockquoteAt(lines, heading + 1)?.text ?? null
  const [, end] = headBullets(lines)
  return end === -1 ? null : (blockquoteAt(lines, end)?.text ?? null)
}

function linkedinOf(lines: readonly string[]): string | null {
  const index = lines.findIndex((line) => /^\*\*LinkedIn note\b/i.test(line))
  if (index === -1) return null
  const inline = (lines[index] ?? '').replace(/^\*\*[^*]*\*\*:?/, '').trim()
  if (inline.length > 0 && !inline.startsWith('—') && !inline.endsWith(':')) return inline
  return blockquoteAt(lines, index + 1)?.text ?? null
}

function formOf(lines: readonly string[], kit: Kit): { readonly form: readonly FormAnswer[]; readonly refs: readonly PackageKitRef[] } {
  const block = blockAfter(lines, /^\*\*Likely form questions\b/i) ?? []
  const items = block
    .map((line) => /^-\s+\*(.+?)\*\s*(?:[—–-]\s*(.*))?$/.exec(line))
    .filter((match) => match !== null)
  const resolved = items.map((match) => {
    const question = (match[1] ?? '').trim()
    return { question, ...resolveFormAnswer(question, match[2] ?? '', kit) }
  })
  return {
    form: resolved.map(({ question, answer, hint }) => ({ question, answer: slotPortfolio(answer), hint })),
    refs: resolved.flatMap(({ question, ref }) => (ref === null ? [] : [{ question, ...ref }])),
  }
}

const listOf = (text: string, separator: string): readonly string[] =>
  text.replace(/\.\s*$/, '').split(separator).map((item) => item.trim()).filter((item) => item.length > 0)

function skillsOf(lines: readonly string[]): Skills | null {
  const line = lines.find((candidate) => /^\*\*Skills to tick:\*\*/i.test(candidate))
  if (line === undefined) return null
  const match = /^\*\*Skills to tick:\*\*\s*(.*?)\s*(?:\*\*Do not tick:\*\*\s*(.*))?$/i.exec(line)
  return { tick: listOf(match?.[1] ?? '', ' · '), doNotTick: listOf(match?.[2] ?? '', ', ') }
}

function notesOf(lines: readonly string[]): string {
  return (blockAfter(lines, /^\*\*Owner notes\b/i) ?? []).join('\n').trim()
}

function cvBaseOf(value: string | undefined): 'A' | 'B' | null {
  const letter = /^([AB])\b/.exec(value?.trim() ?? '')?.[1]
  return letter === 'A' || letter === 'B' ? letter : null
}

function entryOf(n: number, company: string, lines: readonly string[], kit: Kit): PackageEntry {
  const fields = fieldsOf(lines)
  const sendVia = fields.get('send via') ?? null
  const primary = sendVia === null ? '' : (splitSendVia(sendVia)[0] ?? '')
  const { channel, target } = channelOf(primary)
  const body = bodyOf(lines)
  const subject = fields.get('subject') ?? null
  const role = fields.get('role') ?? null
  const cvBase = cvBaseOf(fields.get('cv version'))
  const { form, refs } = formOf(lines, kit)
  const linkedin = linkedinOf(lines)
  const missing = [
    ...(sendVia === null ? ['sendVia'] : []),
    ...(role === null ? ['role'] : []),
    ...(cvBase === null ? ['cvBase'] : []),
    ...(body === null ? ['body'] : []),
    ...(channel === 'email' && subject === null ? ['subject'] : []),
  ]
  return {
    n,
    company,
    channel,
    target,
    sendVia,
    contact: fields.get('contact') ?? null,
    role,
    cvBase,
    adStatus: fields.get('ad status') ?? null,
    letter: body === null ? null : { subject, body: slotPortfolio(body) },
    form,
    skills: skillsOf(lines),
    linkedin: linkedin === null ? null : slotPortfolio(linkedin),
    notes: notesOf(lines),
    kitRefs: refs,
    missing,
  }
}

/** A package file → its entries: each `## N. Company` up to the next `---`. */
export function parsePackage(file: string, markdown: string, kit: Kit): PackageFile {
  const entries = sectionsOf(markdown).map((section) => {
    const end = section.lines.findIndex((line) => line.trim() === '---')
    const lines = end === -1 ? section.lines : section.lines.slice(0, end)
    return entryOf(section.n, section.title, lines, kit)
  })
  return { file, entries }
}
