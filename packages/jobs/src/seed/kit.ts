/**
 * The kit of the seed (`00-kit-base.md`) and the base CVs (`01-cvs.md`), design D8 steps 2 and 3. Pure.
 *
 * The kit mixes answers with notes for the owner (callouts, checkboxes, advice paragraphs) and those
 * carry brackets the linter would block; only the blockquote under each bold question is an answer.
 */

import { blockquoteAt, bracketTokens, sectionsOf, slotSignature, splitSections, type Section, type UnparsedHeading } from './markdown.ts'

export interface KitQuestion {
  readonly label: string
  readonly answer: string
}

/** An answer that still carries a `[…]` after the slots were translated: reported, and carried (the linter blocks it). */
export interface KitLeftover {
  readonly section: number
  readonly label: string
  readonly token: string
}

export interface Kit {
  readonly sections: ReadonlyMap<number, readonly KitQuestion[]>
  readonly leftovers: readonly KitLeftover[]
  /** `## ` headings that are not `## N. Title`: not read, reported. */
  readonly unparsed: readonly UnparsedHeading[]
  readonly issues: readonly KitIssue[]
}

/** What the kit parser could not take: a label without an answer, a section number used twice. */
export interface KitIssue {
  readonly kind: 'kit-label-without-answer' | 'kit-duplicate-section'
  readonly section: number
  /** The label, or the title of the repeated section. */
  readonly detail: string
}

/** `§N` plus the words of the «see …» phrase before the link (e.g. «the 100-word bio in»). */
export interface KitRef {
  readonly section: number
  readonly phrase: string
}

export interface KitMatch {
  readonly section: number
  readonly label: string
  readonly answer: string
  readonly ambiguous: boolean
}

/** For the import report (`kitRefs`): which question a cite matched; `matched: null` = the section is not in the kit. */
export interface KitRefResult {
  readonly section: number
  readonly matched: string | null
  readonly ambiguous: boolean
}

export interface ResolvedAnswer {
  readonly answer: string
  /** A note for the owner (the parenthesis or `;` after a cite): shown in the panel, never copied nor sent. */
  readonly hint: string | null
  readonly ref: KitRefResult | null
}

/** The follow-up templates of the profile (design D7 `followup`), seeded once from kit §7 and §8. */
export interface FollowupTemplates {
  readonly subject: string
  readonly first: string
  readonly second: string
  readonly linkedin: string
}

export interface BaseCvs {
  readonly A: string
  readonly B: string
}

/** The kit's TODOs that become slots (design D6 «Huecos»). */
const KIT_SLOTS: readonly (readonly [RegExp, string])[] = [
  [/\[suburb\b[^\]\n]*\bTODO\b[^\]\n]*\]/gi, '{suburb}'],
  [/\[timezone\b[^\]\n]*\bTODO\b[^\]\n]*\]/gi, '{timezone}'],
  [/\[your hourly rate\b[^\]\n]*\bTODO\b[^\]\n]*\]/gi, '{rate}'],
]

const LABEL_LINE = /^\*\*(.+?)\*\*\s*$/
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'in', 'of', 'for', 'on', 'at', 'do', 'does', 'did', 'you', 'your', 'have', 'has',
  'is', 'are', 'be', 'was', 'what', 'which', 'who', 'how', 'any', 'see', 'and', 'or', 'if', 'with', 'from',
  'by', 'i', 'my', 'me', 'it', 'this', 'that', 'can', 'will', 'would', 'should', 'please', 'there', 'their',
  'our', 'we', 'us', 'as', 'about', 'into', 'than', 'then', 'where', 'when', 'why',
])

const translateSlots = (text: string): string =>
  KIT_SLOTS.reduce((current, [pattern, slot]) => current.replace(pattern, slot), text)

const cleanLabel = (raw: string): string => raw.trim().replace(/:$/, '').replace(/^["“”]+|["“”]+$/g, '').trim()

interface SectionQuestions {
  readonly questions: readonly KitQuestion[]
  /** Bold labels with no blockquote under them (a blank line then a callout, advice, nothing). */
  readonly unanswered: readonly string[]
}

function questionsOf(section: Section): SectionQuestions {
  const questions: KitQuestion[] = []
  const unanswered: string[] = []
  for (let index = 0; index < section.lines.length; index += 1) {
    const label = LABEL_LINE.exec(section.lines[index] ?? '')
    if (!label) continue
    const quote = blockquoteAt(section.lines, index + 1)
    if (quote === null) {
      unanswered.push(cleanLabel(label[1] ?? ''))
      continue
    }
    questions.push({ label: cleanLabel(label[1] ?? ''), answer: translateSlots(quote.text) })
    index = quote.next - 1
  }
  return { questions, unanswered }
}

/** Sections whose number came before: the first of a number wins, the rest are issues. */
function repeatedSections(sections: readonly Section[]): ReadonlySet<Section> {
  const seen = new Set<number>()
  return new Set(
    sections.filter((section) => {
      const repeated = seen.has(section.n)
      seen.add(section.n)
      return repeated
    }),
  )
}

/**
 * `00-kit-base.md` → `§N → { label, answer }[]`, with the kit's TODOs translated into slots. A label
 * with no answer and a section number used twice are `issues`, never dropped silently.
 */
export function parseKit(markdown: string): Kit {
  const { sections, unparsed } = splitSections(markdown)
  const repeated = repeatedSections(sections)
  const read = sections.map((section) => ({ section, ...questionsOf(section) }))
  const kept = read.filter(({ section }) => !repeated.has(section))
  const entries = kept.map(({ section, questions }) => [section.n, questions] as const)
  const leftovers = entries.flatMap(([section, questions]) =>
    questions.flatMap((question) => bracketTokens(question.answer).map((token) => ({ section, label: question.label, token }))),
  )
  const issues: KitIssue[] = [
    ...read.flatMap(({ section, unanswered }) => unanswered.map((label) => ({ kind: 'kit-label-without-answer' as const, section: section.n, detail: label }))),
    ...[...repeated].map((section) => ({ kind: 'kit-duplicate-section' as const, section: section.n, detail: section.title })),
  ]
  return { sections: new Map(entries), leftovers, unparsed, issues }
}

function wordsOf(text: string): ReadonlySet<string> {
  const words = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word))
  return new Set(words)
}

/**
 * The kit question a cite points at (design D8 step 2): the only one of its section, or the one whose
 * label shares most normalised words with the form question and the «see …» phrase. A tie or no word
 * in common → the first, `ambiguous`. Null when the section is not in the kit or has no question.
 */
export function resolveKitRef(question: string, ref: KitRef, kit: Kit): KitMatch | null {
  const questions = kit.sections.get(ref.section) ?? []
  const [first] = questions
  if (first === undefined) return null
  if (questions.length === 1) return { section: ref.section, label: first.label, answer: first.answer, ambiguous: false }
  const asked = wordsOf(`${question} ${ref.phrase}`)
  const scored = questions.map((candidate) => ({
    candidate,
    score: [...wordsOf(candidate.label)].filter((word) => asked.has(word)).length,
  }))
  const best = Math.max(...scored.map((entry) => entry.score))
  const winners = scored.filter((entry) => entry.score === best)
  const chosen = best === 0 ? first : (winners[0]?.candidate ?? first)
  return { section: ref.section, label: chosen.label, answer: chosen.answer, ambiguous: best === 0 || winners.length > 1 }
}

/** «see [the 100-word bio in] [[00-kit-base]] §N». */
const CITE = /see\b([^[\n]*?)\[\[[^\]\n]+\]\]\s*§\s*(\d+)/i

/** The index of the `)` that closes `open`, or -1. */
function closingParen(text: string, open: number): number {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1
    if (text[index] === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Where a cite fragment that is not parenthesised ends: its enclosing `)` or the end of its sentence. */
function fragmentEnd(text: string, from: number): number {
  let depth = 0
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(') depth += 1
    if (char === ')') {
      if (depth === 0) return index
      depth -= 1
    }
    if (depth === 0 && /[.!?]/.test(char ?? '') && /\s|$/.test(text[index + 1] ?? '')) return index
  }
  return text.length
}

function hintAfter(rest: string): string | null {
  const trimmed = rest.trim()
  if (trimmed.startsWith('(')) {
    const close = closingParen(trimmed, 0)
    return trimmed.slice(1, close === -1 ? undefined : close).trim() || null
  }
  return trimmed.replace(/^[;,—–-]\s*/, '').replace(/\.$/, '').trim() || null
}

function resolveSoleCite(question: string, answer: string, match: RegExpExecArray, kit: Kit): ResolvedAnswer {
  const section = Number(match[2])
  const hint = hintAfter(answer.slice(match.index + match[0].length))
  const found = resolveKitRef(question, { section, phrase: (match[1] ?? '').trim() }, kit)
  if (found === null) {
    const missing = `kit §${section} not found`
    return { answer, hint: hint === null ? missing : `${missing}; ${hint}`, ref: { section, matched: null, ambiguous: false } }
  }
  return { answer: found.answer, hint, ref: { section, matched: found.label, ambiguous: found.ambiguous } }
}

/** Takes the cite fragments out of a written answer; each goes to `hint`. */
function liftEmbeddedCites(answer: string): ResolvedAnswer {
  let text = answer
  const hints: string[] = []
  for (let match = CITE.exec(text); match !== null; match = CITE.exec(text)) {
    const before = text.slice(0, match.index)
    const opener = /\s*\(\s*$/.exec(before)
    if (opener) {
      const open = before.lastIndexOf('(')
      const close = closingParen(text, open)
      const end = close === -1 ? text.length : close + 1
      hints.push(text.slice(open + 1, close === -1 ? undefined : close).trim())
      text = text.slice(0, opener.index) + text.slice(end)
      continue
    }
    const dash = /\s*[—–-]?\s*$/.exec(before)
    const start = dash ? dash.index : match.index
    const end = Math.max(fragmentEnd(text, match.index), match.index + match[0].length)
    hints.push(text.slice(match.index, end).trim())
    text = text.slice(0, start) + text.slice(end)
  }
  return { answer: text.trim(), hint: hints.length > 0 ? hints.join('; ') : null, ref: null }
}

/**
 * A form answer of the package with its kit cite resolved (design D8 step 2). An answer that is only
 * the cite becomes the kit answer, and what follows it (a parenthesis, a `;`) goes to `hint`. A cite
 * inside a written answer leaves the answer and lifts only its fragment out to `hint`.
 */
export function resolveFormAnswer(question: string, answer: string, kit: Kit): ResolvedAnswer {
  const trimmed = answer.trim()
  const match = CITE.exec(trimmed)
  if (match === null) return { answer: trimmed, hint: null, ref: null }
  if (match.index === 0) return resolveSoleCite(question, trimmed, match, kit)
  return liftEmbeddedCites(trimmed)
}

const SPECIFIC_THING = /[^.!?\n]*\[one specific thing[^\]\n]*\][^.!?\n]*[.!?]/i
const STILL_INTERESTED = "I'm still very interested in the {role} role at {company}."
const ONCE_MORE = "I'm following up once more on my application for the {role} position, sent on {sentDate}."

const translateTemplate = (text: string): string =>
  slotSignature(text)
    .text.replace(/\[role\]/gi, '{role}')
    .replace(/\[name \/ company team\]/gi, '{greetingName}')
    .replace(/\[name\]/gi, '{greetingName}')
    .replace(/\[company\]/gi, '{company}')
    .replace(/\[date\]/gi, '{sentDate}')
    .replace(SPECIFIC_THING, (sentence) => `${/^\s*/.exec(sentence)?.[0] ?? ''}${STILL_INTERESTED}`)
    .replace(/\s*My CV is attached again for convenience\./i, '')

/** The second follow-up: the same body with the first sentence after the greeting changed. */
function secondOf(first: string): string {
  const paragraphs = first.split('\n\n')
  const opening = paragraphs[1]
  if (opening === undefined) return first
  const rest = opening.replace(/^[^.!?]*[.!?]/, '')
  return [paragraphs[0], `${ONCE_MORE}${rest}`, ...paragraphs.slice(2)].join('\n\n')
}

function firstQuote(section: Section | undefined): string | null {
  if (section === undefined) return null
  const start = section.lines.findIndex((line) => line.startsWith('>'))
  return start === -1 ? null : (blockquoteAt(section.lines, start)?.text ?? null)
}

/**
 * The seed of the profile's follow-up templates (design D8 step 2): §7 subject and body, §8 LinkedIn
 * note, with the tokens translated, the «[one specific thing…]» sentence replaced and the «CV attached»
 * sentence removed (a follow-up never attaches a CV). A `[…]` left after translating → a warning and no
 * templates: the owner writes them in settings.
 */
export function seedFollowupTemplates(markdown: string): { readonly templates: FollowupTemplates | null; readonly warnings: readonly string[] } {
  const sections = sectionsOf(markdown)
  const seven = sections.find((section) => section.n === 7)
  const subjectLine = seven?.lines.map((line) => /^\*\*Subject:\*\*\s*(.+)$/.exec(line)).find((match) => match !== null)
  const body = firstQuote(seven)
  const note = firstQuote(sections.find((section) => section.n === 8))
  const warnings: string[] = []
  if (subjectLine == null || body === null) warnings.push('kit §7: no follow-up email found')
  if (note === null) warnings.push('kit §8: no LinkedIn note found')
  if (subjectLine == null || body === null || note === null) return { templates: null, warnings }

  const first = translateTemplate(body)
  const templates: FollowupTemplates = {
    subject: translateTemplate(subjectLine[1] ?? '').trim(),
    first,
    second: secondOf(first),
    linkedin: translateTemplate(note),
  }
  const left = [
    ...[templates.subject, templates.first].flatMap((text) => bracketTokens(text).map((token) => `kit §7: ${token} left after translating`)),
    ...bracketTokens(templates.linkedin).map((token) => `kit §8: ${token} left after translating`),
  ]
  return left.length > 0 ? { templates: null, warnings: left } : { templates, warnings: [] }
}

function cvOf(lines: readonly string[], letter: 'A' | 'B'): string {
  const start = lines.findIndex((line) => new RegExp(`^#\\s+CV ${letter}\\b`).test(line))
  if (start === -1) throw new Error(`cvs: no "# CV ${letter}" heading`)
  const after = lines.slice(start + 1)
  const stop = after.findIndex((line) => /^##\s+Para el owner\b/.test(line) || /^#\s+CV\b/.test(line))
  return (stop === -1 ? after : after.slice(0, stop)).join('\n').trim().replace(/\n*---$/, '').trim()
}

/** `01-cvs.md` → `{ A, B }`: each from its `# CV X` heading to `## Para el owner` (design D8 step 3). */
export function parseCvs(markdown: string): BaseCvs {
  const lines = markdown.split(/\r?\n/)
  return { A: cvOf(lines, 'A'), B: cvOf(lines, 'B') }
}
