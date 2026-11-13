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

/**
 * The block each slot gives when its field is empty; `{rate}` gives none. `{signature}` is
 * `missing-phone` for its phone, and `missing-profile-field` for its name or email (`Filled.blocks`).
 */
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

/** A slot that stayed unfilled: the block it gives and the profile field that is empty (D6, `detail`). */
export interface SlotBlock {
  readonly slot: SlotName
  readonly code: WarningCode
  /** The key of `profile.identity` the owner fills to clear it. */
  readonly field: IdentityField
}

type IdentityField = keyof Profile['identity']

/**
 * What `{signature}` needs, in the order its blocks are named: the phone is `missing-phone` (the D6
 * table); a name or an email is `missing-profile-field` with the field («Huecos»: a slot without its
 * field gives its own block, with the field in the `detail`). LinkedIn is optional.
 */
const SIGNATURE_NEEDS: readonly (readonly [IdentityField, WarningCode])[] = [
  ['name', 'missing-profile-field'],
  ['email', 'missing-profile-field'],
  ['phone', 'missing-phone'],
]

/** The field each other slot reads; `{rate}` reads the preferences and never blocks. */
const SLOT_FIELD: Readonly<Record<Exclude<SlotName, 'signature' | 'rate'>, IdentityField>> = {
  suburb: 'suburb',
  timezone: 'timezone',
  portfolio: 'portfolioUrl',
}

const present = (value: string): string | null => (value.trim() === '' ? null : value.trim())
const isEmpty = (profile: Profile, field: IdentityField): boolean => present(profile.identity[field]) === null

/**
 * The signature line: name · email · phone · LinkedIn (the order of the package's signatures), or
 * null when the name, the email or the phone is empty — a partial signature never goes out.
 */
export function signatureOf(profile: Profile): string | null {
  if (SIGNATURE_NEEDS.some(([field]) => isEmpty(profile, field))) return null
  const { name, email, phone, linkedin } = profile.identity
  return [name, email, phone, linkedin]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(SEPARATOR)
}

/** The value of a slot, or null when a field it needs is empty. */
function valueOf(slot: SlotName, profile: Profile): string | null {
  switch (slot) {
    case 'signature':
      return signatureOf(profile)
    case 'rate':
      return present(profile.preferences.rateExpectation) ?? RATE_NEUTRAL
    default:
      return present(profile.identity[SLOT_FIELD[slot]])
  }
}

/** The blocks an unfilled slot gives: one per empty field it needs. */
function blocksOf(slot: SlotName, profile: Profile): readonly SlotBlock[] {
  if (slot === 'signature') return SIGNATURE_NEEDS.filter(([field]) => isEmpty(profile, field)).map(([field, code]) => ({ slot, code, field }))
  if (slot === 'rate') return []
  const code = SLOT_WARNING[slot]
  return code === null ? [] : [{ slot, code, field: SLOT_FIELD[slot] }]
}

export interface Filled {
  readonly text: string
  /** The slots left unfilled, once each, in the order they first appear. */
  readonly missing: readonly SlotName[]
  /** What those slots block on, each with its empty field (the linter's `detail`). */
  readonly blocks: readonly SlotBlock[]
}

export function fillSlots(text: string, profile: Profile): Filled {
  const missing: SlotName[] = []
  const filled = text.replace(SLOT, (token, name: SlotName) => {
    const value = valueOf(name, profile)
    if (value !== null) return value
    if (!missing.includes(name)) missing.push(name)
    return token
  })
  return { text: filled, missing, blocks: missing.flatMap((slot) => blocksOf(slot, profile)) }
}
