/**
 * The word lists of design D6 that are the package's and not the owner's: the health keywords and
 * the health mentions. ONE COPY, read by the prompt that asks for a neutral CV (`prompts/cv.ts`)
 * and by the linter that checks it got one (`lint.ts`): a list written in two places drifts.
 *
 * The owner's lists (`forbiddenStacks`, `redLines.titleWords`, `confidential`) live in the profile.
 */

/** design D6, «Keyword de salud»: acronyms, matched with their exact capitals (`matchTerm`). */
export const HEALTH_KEYWORDS = ['HL7', 'FHIR', 'DICOM', 'RIS', 'PACS', 'EHR', 'EMR', 'HIS', 'HIPAA'] as const

/** design D6, «Menciones de salud»: words, whole, in any case. */
export const HEALTH_WORDS = ['health', 'healthcare', 'clinical', 'clinic', 'hospital', 'patient', 'medical'] as const

/** More than this many mentions, at a company that is not a health employer, blocks (D6). */
export const MAX_HEALTH_MENTIONS = 2

/** A term shorter than this many letters, written with a capital in its list, matches exactly (`Go`). */
const SHORT_TERM_LETTERS = 3

/** Without accents: «Médica» and «Medica» are one word. */
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '')

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * design D6: an acronym (no lowercase letter: `HIS`, `EHR`, `HL7`) or a short term with a capital
 * (≤ 3 letters: `Go`) matches with its exact capitals; anything else in any case. Accents never count.
 */
export function isExactTerm(term: string): boolean {
  const hasCapital = /\p{Lu}/u.test(term)
  const letters = term.match(/\p{L}/gu)?.length ?? 0
  return hasCapital && (!/\p{Ll}/u.test(term) || letters <= SHORT_TERM_LETTERS)
}

export interface TermOptions {
  /** Ignore the term's capitals whatever it looks like: confidential names (D6, «Excepción»). */
  readonly anyCase?: boolean
  /** Also count the term followed by an `s` (health mentions: «patients»). */
  readonly plural?: boolean
}

/**
 * How many times `term` is in `text` as a WHOLE word — bounded by anything that is not a letter or a
 * digit, so `HL7` and `C++` match and «Gopher», «Golang» or «HL70» do not. Pure.
 */
export function countTerm(text: string, term: string, options: TermOptions = {}): number {
  const folded = fold(term.trim())
  if (folded === '') return 0
  const exact = options.anyCase !== true && isExactTerm(folded)
  const pattern = `(?<![\\p{L}\\p{N}])${escapeRegExp(folded)}${options.plural === true ? 's?' : ''}(?![\\p{L}\\p{N}])`
  return fold(text).match(new RegExp(pattern, exact ? 'gu' : 'giu'))?.length ?? 0
}

/** `matchTerm(text, term)` of design D6. */
export const matchTerm = (text: string, term: string, options: TermOptions = {}): boolean => countTerm(text, term, options) > 0
