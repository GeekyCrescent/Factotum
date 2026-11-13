/**
 * The linter (design D6; tasks L1, L2). PURE: artifacts and a context in, warnings out — no store,
 * no file, no clock. What it cannot see, the caller looks at first and hands in: whether the PDF is
 * on disk (`pdfExists`, a `stat`) and whether a letter is still on its way (`letterPending`, from
 * `gen_requests` and `work`).
 *
 * IT LINTS WHAT WOULD BE SENT. Every text goes through `fillSlots` with the profile of the moment
 * first (B6b): a known slot is filled and is NOT a placeholder; a slot whose field is empty gives its
 * own block (`missing-phone`, `missing-profile-field`, `missing-portfolio`) with the field as
 * `detail`. The CV has no slots (its contact is the template's, D5), so any `{x}` in it is debris.
 *
 * THE RULES COME OUT IN THE ORDER OF D6's TABLE, once each (`code`, `where`, `detail`). A `detail`
 * names the token, the term, the field or the count — never the whole text.
 *
 * Two lint profiles (v4, A3): «application» (`lint`, every rule) and «follow-up» (`lintFollowup`:
 * placeholder also in `to`, slots, confidential name and too long; a follow-up carries no CV and no
 * new figure).
 */

import { BRACKET_TOKEN, isSendableAddress } from '../shape.ts'
import type { Artifacts, Channel, Company, CvDoc, FollowupVersion, Opportunity, Profile, Warning, WarningCode } from '../types.ts'
import { unknownNumbers } from './numbers.ts'
import { contactHashOf } from './render.ts'
import { fillSlots, isSlotName } from './slots.ts'
import { countTerm, HEALTH_KEYWORDS, HEALTH_WORDS, matchTerm, MAX_HEALTH_MENTIONS } from './terms.ts'

export interface LintContext {
  /** `cv-maestro.md`, whole: a source of allowed numbers (L2). */
  readonly master: string
  readonly profile: Profile
  readonly opportunity: Pick<Opportunity, 'kind' | 'title' | 'requirements' | 'salary' | 'hours' | 'duration'>
  /** `record`: the text of the company's seeded fields (D8), a source of allowed numbers (L2). */
  readonly company: Pick<Company, 'isHealthEmployer'> & { readonly record: string }
  readonly channel: Channel
  /** `target.to`; checked only when `channel` is `email` (v5, X11). */
  readonly to: string | null
  /** The caller's `stat` of `artifacts.pdf`. */
  readonly pdfExists: boolean
  /** A `letter` request of this application is `queued` or `running` (v6, M9). */
  readonly letterPending: boolean
}

export interface FollowupLintContext {
  readonly profile: Profile
  readonly channel: 'email' | 'linkedin'
  readonly to: string | null
}

type Where = Warning['where']

/** One text as it would be sent, with the slots it could not fill. */
interface Text {
  readonly where: Where
  /** Filled. */
  readonly text: string
  readonly slotBlocks: readonly Warning[]
  /** False for the CV: there a known slot name is debris too. */
  readonly hasSlots: boolean
}

/** design D6, «Demasiado largo». */
export const MAX_LETTER_WORDS = 220
export const MAX_EMAIL_WORDS = 150
export const MAX_LINKEDIN_CHARS = 280
export const MAX_SUBJECT_CHARS = 90
const MAX_GAP_DETAIL = 160

const BRACKETS = new RegExp(BRACKET_TOKEN.source, 'g')
const BRACES = /\{([A-Za-z]+)\}/g
const DEBRIS: readonly (readonly [RegExp, string])[] = [
  [/\bTODO\b/, 'TODO'],
  [/\bTBD\b/, 'TBD'],
  [/lorem/i, 'lorem'],
]
const SIGNATURE = /\{signature\}/g

const warn = (code: WarningCode, where: Where, detail: string, blocks = true): Warning => ({ code, where, detail, blocks, overridden: null })

function filled(where: Where, raw: string, profile: Profile): Text {
  const result = fillSlots(raw, profile)
  return { where, text: result.text, slotBlocks: result.blocks.map((b) => warn(b.code, where, b.field)), hasSlots: true }
}

/** Every printed string of the CV, one per line; `source` and `gaps` are never printed. */
export function cvText(doc: CvDoc): string {
  return [
    doc.headline,
    doc.summary,
    ...doc.experience.flatMap((e) => [e.org, e.title, e.dates, e.place ?? '', e.line ?? '', ...e.bullets.map((b) => b.text)]),
    ...doc.projects.flatMap((p) => [p.name, p.role, p.status, p.text]),
    ...doc.education.map((e) => e.text),
    ...doc.certifications,
    ...doc.skills.flatMap((s) => [s.label, ...s.items]),
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function textsOf(artifacts: Artifacts, profile: Profile): readonly Text[] {
  const { letter } = artifacts
  return [
    ...(letter?.subject == null ? [] : [filled('subject', letter.subject, profile)]),
    ...(letter === null ? [] : [filled('letter', letter.body, profile)]),
    ...artifacts.form.map((f) => filled('form', f.answer, profile)),
    ...(artifacts.linkedin === null ? [] : [filled('linkedin', artifacts.linkedin, profile)]),
    ...(artifacts.cv === null ? [] : [{ where: 'cv' as const, text: cvText(artifacts.cv), slotBlocks: [], hasSlots: false }]),
  ]
}

// — Placeholder —

function placeholdersIn({ where, text, hasSlots }: Text): readonly Warning[] {
  const brackets = [...text.matchAll(BRACKETS)].map((m) => m[0])
  const debris = DEBRIS.filter(([pattern]) => pattern.test(text)).map(([, name]) => name)
  const braces = [...text.matchAll(BRACES)].filter((m) => !hasSlots || !isSlotName(m[1] ?? '')).map((m) => m[0])
  return [...brackets, ...debris, ...braces].map((token) => warn('placeholder', where, token))
}

function addressWarnings(channel: Channel | 'linkedin', to: string | null): readonly Warning[] {
  if (channel !== 'email') return []
  if (to === null || to.trim() === '') return [warn('placeholder', 'to', 'no address')]
  return isSendableAddress(to.trim()) ? [] : [warn('placeholder', 'to', 'not an email address')]
}

// — Names and words —

function confidentialIn(texts: readonly Text[], profile: Profile): readonly Warning[] {
  return texts.flatMap(({ where, text }) => profile.confidential.filter((name) => matchTerm(text, name, { anyCase: true })).map((name) => warn('confidential-name', where, name)))
}

function healthIn(texts: readonly Text[], isHealthEmployer: boolean): readonly Warning[] {
  if (isHealthEmployer) return []
  const keywords = texts.flatMap(({ where, text }) => HEALTH_KEYWORDS.filter((term) => matchTerm(text, term)).map((term) => warn('health-keyword', where, term)))
  const mentions = texts.flatMap(({ where, text }) => {
    const count = HEALTH_WORDS.reduce((sum, word) => sum + countTerm(text, word, { plural: true }), 0)
    return count > MAX_HEALTH_MENTIONS ? [warn('health-mentions', where, `${count} mentions (at most ${MAX_HEALTH_MENTIONS})`)] : []
  })
  return [...keywords, ...mentions]
}

function forbiddenIn(texts: readonly Text[], profile: Profile): readonly Warning[] {
  const cv = texts.filter((t) => t.where === 'cv')
  return cv.flatMap(({ where, text }) => profile.forbiddenStacks.filter((stack) => matchTerm(text, stack)).map((stack) => warn('forbidden-stack', where, stack)))
}

/** L2: the figures of the CV and the letter (subject included) need a source; the rest are not checked. */
const NUMBERED: ReadonlySet<Where> = new Set(['cv', 'letter', 'subject'])

function unknownNumbersIn(texts: readonly Text[], ctx: LintContext): readonly Warning[] {
  return texts
    .filter((t) => NUMBERED.has(t.where))
    .flatMap(({ where, text }) => unknownNumbers(text, ctx).map((figure) => warn('unknown-number', where, `number ${figure} not in cv-maestro`)))
}

// — Too long —

const wordsIn = (text: string): number => text.split(/\s+/).filter((word) => word !== '').length

function tooLong(where: Where, raw: string, filledText: string, channel: Channel | 'linkedin'): readonly Warning[] {
  const over = (what: string, size: number, max: number, unit: string): readonly Warning[] =>
    size > max ? [warn('too-long', where, `${what} ${size} ${unit} (at most ${max})`, false)] : []
  if (where === 'subject') return over('subject', filledText.length, MAX_SUBJECT_CHARS, 'characters')
  if (where === 'linkedin' || channel === 'linkedin') return over('LinkedIn note', filledText.length, MAX_LINKEDIN_CHARS, 'characters')
  if (channel === 'email') return over('email', wordsIn(raw.replace(SIGNATURE, ' ')), MAX_EMAIL_WORDS, 'words')
  return over('letter', wordsIn(filledText), MAX_LETTER_WORDS, 'words')
}

function tooLongIn(artifacts: Artifacts, texts: readonly Text[], channel: Channel): readonly Warning[] {
  const raw: Partial<Record<Where, string>> = { subject: artifacts.letter?.subject ?? '', letter: artifacts.letter?.body ?? '', linkedin: artifacts.linkedin ?? '' }
  return texts.filter((t) => t.where in raw).flatMap((t) => tooLong(t.where, raw[t.where] ?? '', t.text, channel))
}

// — The CV and the letter —

function cvWarnings(artifacts: Artifacts, ctx: LintContext): readonly Warning[] {
  const phone = artifacts.cv !== null && ctx.profile.identity.phone.trim() === '' ? [warn('missing-phone', 'cv', 'phone')] : []
  const missing =
    artifacts.cv === null ? 'no CV' : artifacts.pdf === null ? 'no PDF' : ctx.pdfExists ? null : 'the PDF is not on disk'
  const stale = missing === null && artifacts.contactHash !== contactHashOf(ctx.profile) ? [warn('cv-stale', 'cv', 'printed with another contact')] : []
  return [...phone, ...stale, ...(missing === null ? [] : [warn('missing-cv', 'cv', missing)])]
}

function adWarnings(artifacts: Artifacts, ctx: LintContext): readonly Warning[] {
  const senior = ctx.profile.redLines.titleWords.filter((word) => matchTerm(ctx.opportunity.title, word)).map((word) => warn('senior-title', 'ad', word, false))
  const gaps = ctx.opportunity.kind === 'vacancy' ? (artifacts.cv?.gaps ?? []) : []
  return [...senior, ...gaps.map((gap) => warn('requirement-gap', 'ad', gap.requirement.slice(0, MAX_GAP_DETAIL), false))]
}

function once(warnings: readonly Warning[]): readonly Warning[] {
  const seen = new Set<string>()
  return warnings.filter((w) => {
    const key = `${w.code}\0${w.where}\0${w.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The «application» profile: every rule of D6's table, in its order. */
export function lint(artifacts: Artifacts, ctx: LintContext): readonly Warning[] {
  const texts = textsOf(artifacts, ctx.profile)
  return once([
    ...addressWarnings(ctx.channel, ctx.to),
    ...texts.flatMap(placeholdersIn),
    ...texts.flatMap((t) => t.slotBlocks),
    ...confidentialIn(texts, ctx.profile),
    ...healthIn(texts, ctx.company.isHealthEmployer),
    ...forbiddenIn(texts, ctx.profile),
    ...unknownNumbersIn(texts, ctx),
    ...tooLongIn(artifacts, texts, ctx.channel),
    ...cvWarnings(artifacts, ctx),
    ...(artifacts.letter === null && !ctx.letterPending ? [warn('missing-letter', 'letter', 'no letter')] : []),
    ...adWarnings(artifacts, ctx),
  ])
}

/** The «follow-up» profile (v4, A3), over subject and body as stored (with slots). */
export function lintFollowup(version: Pick<FollowupVersion, 'subject' | 'body'>, ctx: FollowupLintContext): readonly Warning[] {
  const subject = version.subject === null ? [] : [filled('subject', version.subject, ctx.profile)]
  const body = filled('followup', version.body, ctx.profile)
  const texts = [...subject, body]
  return once([
    ...addressWarnings(ctx.channel, ctx.to),
    ...texts.flatMap(placeholdersIn),
    ...texts.flatMap((t) => t.slotBlocks),
    ...confidentialIn(texts, ctx.profile),
    ...(version.subject === null ? [] : tooLong('subject', version.subject, subject[0]?.text ?? '', ctx.channel)),
    ...tooLong('followup', version.body, body.text, ctx.channel),
  ])
}
