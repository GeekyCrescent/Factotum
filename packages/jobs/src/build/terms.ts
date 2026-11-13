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
