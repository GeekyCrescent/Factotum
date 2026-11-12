/**
 * Slots (design D6, «Huecos»): stored texts never carry profile data, they carry `{signature}`,
 * `{suburb}`, `{timezone}`, `{rate}` and `{portfolio}`, filled here with the profile OF THE MOMENT —
 * when sending, when showing, and before linting. Pure.
 *
 * A SLOT WHOSE FIELD IS EMPTY STAYS AS IT WAS and is named in `missing`: the linter turns it into its
 * own block (`SLOT_WARNING`), never into a half-filled text. `{rate}` is the exception (v7, the
 * owner's decision of 13 Nov): empty, it becomes the neutral sentence of the kit and blocks nothing.
 *
 * An unknown `{x}` is not touched: it is the linter's `placeholder` (L1). The follow-up fields
 * (`{role}`, `{company}`…) are `renderFollowup`'s, not slots.
 */

import type { Profile, WarningCode } from '../types.ts'

export const SLOT_NAMES = ['signature', 'suburb', 'timezone', 'rate', 'portfolio'] as const
export type SlotName = (typeof SLOT_NAMES)[number]

/** Kit §3, «Neutral answer (default)», first sentence. */
export const RATE_NEUTRAL = "I'm open to the advertised range."

/** The block each slot gives when its field is empty; `{rate}` gives none. */
export const SLOT_WARNING: Readonly<Record<SlotName, WarningCode | null>> = {
  signature: 'missing-phone',
  suburb: 'missing-profile-field',
  timezone: 'missing-profile-field',
  rate: null,
  portfolio: 'missing-portfolio',
}

const SLOT = /\{(signature|suburb|timezone|rate|portfolio)\}/g
const SEPARATOR = ' · '

export const isSlotName = (value: string): value is SlotName => (SLOT_NAMES as readonly string[]).includes(value)

/** The signature line: name · email · phone · LinkedIn (the order of the package's signatures). */
export function signatureOf(profile: Profile): string {
  const { name, email, phone, linkedin } = profile.identity
  return [name, email, phone, linkedin]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(SEPARATOR)
}

/** The value of a slot, or null when its field is empty. */
function valueOf(slot: SlotName, profile: Profile): string | null {
  const present = (value: string): string | null => (value.trim() === '' ? null : value.trim())
  switch (slot) {
    case 'signature':
      // Without a phone there is no signature: the CV and the letters need it (missing-phone).
      return present(profile.identity.phone) === null ? null : signatureOf(profile)
    case 'suburb':
      return present(profile.identity.suburb)
    case 'timezone':
      return present(profile.identity.timezone)
    case 'rate':
      return present(profile.preferences.rateExpectation) ?? RATE_NEUTRAL
    case 'portfolio':
      return present(profile.identity.portfolioUrl)
  }
}

export interface Filled {
  readonly text: string
  /** The slots left unfilled, once each, in the order they first appear. */
  readonly missing: readonly SlotName[]
}

export function fillSlots(text: string, profile: Profile): Filled {
  const missing: SlotName[] = []
  const filled = text.replace(SLOT, (token, name: SlotName) => {
    const value = valueOf(name, profile)
    if (value !== null) return value
    if (!missing.includes(name)) missing.push(name)
    return token
  })
  return { text: filled, missing }
}
