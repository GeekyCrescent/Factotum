/**
 * The settings page, as data (spec 2026-11-12-postulaciones, design D7; requirements crit. 14–16b).
 * Pure: `settings.tsx` edits a `ProfileForm` of strings and posts what `profileOf` makes of it.
 *
 * TEXT AS TEXT: the prose goes to the prompts as written, so it is a `textarea` and is posted as is.
 * The structured fields — lists, absences, pay floors, numbers — are one line each in the form and are
 * read back here, so a line that does not read is named before anything is posted. The ENGINE stays
 * the judge (`POST /profile` is a strict zod): a `400` comes back with its `field`, which `anchorOfField`
 * turns into the place on the page.
 *
 * What the form does not show (a goal's id) is taken from the version it was read from.
 */

import type { Profile } from './contract.ts'

type Identity = Profile['identity']
type Goal = Profile['goals'][number]

export interface GoalForm {
  readonly label: string
  readonly enabled: boolean
  readonly text: string
  /** «45 AUD per hour», or empty. */
  readonly payFloor: string
  /** «seek, lever». */
  readonly sources: string
}

export interface ProfileForm {
  readonly identity: Identity
  readonly situation: string
  readonly availability: string
  /** One «YYYY-MM-DD → YYYY-MM-DD label» per line. */
  readonly absences: string
  readonly goals: readonly GoalForm[]
  readonly level: string
  readonly redLinesText: string
  /** One per line, as the other lists. */
  readonly titleWords: string
  readonly requirementWords: string
  readonly unpaid: boolean
  readonly equityOnly: boolean
  readonly preferencesText: string
  readonly rateExpectation: string
  readonly forbiddenStacks: string
  readonly confidential: string
  readonly batchSize: string
  readonly weights: Readonly<Record<string, string>>
  readonly followup: Profile['followup']
}

const lines = (list: readonly string[]): string => list.join('\n')
const listOf = (text: string): readonly string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

const payFloorText = (floor: Goal['payFloor']): string => (floor === null ? '' : `${floor.amount} ${floor.currency} per ${floor.per}`)

export function formOf(profile: Profile): ProfileForm {
  return {
    identity: profile.identity,
    situation: profile.situation,
    availability: profile.availability,
    absences: lines(profile.absences.map((a) => `${a.from} → ${a.to} ${a.label}`.trimEnd())),
    goals: profile.goals.map((g) => ({ label: g.label, enabled: g.enabled, text: g.text, payFloor: payFloorText(g.payFloor), sources: g.sources.join(', ') })),
    level: profile.level,
    redLinesText: profile.redLines.text,
    titleWords: lines(profile.redLines.titleWords),
    requirementWords: lines(profile.redLines.requirementWords),
    unpaid: profile.redLines.unpaid,
    equityOnly: profile.redLines.equityOnly,
    preferencesText: profile.preferences.text,
    rateExpectation: profile.preferences.rateExpectation,
    forbiddenStacks: lines(profile.forbiddenStacks),
    confidential: lines(profile.confidential),
    batchSize: String(profile.batchSize),
    weights: Object.fromEntries(Object.entries(profile.weights).map(([key, value]) => [key, String(value)])),
    followup: profile.followup,
  }
}

export type ProfileOutcome = { readonly ok: true; readonly profile: Profile } | { readonly ok: false; readonly field: string; readonly why: string }

/** Thrown inside `profileOf` only, and caught there: a line that does not read, and where. */
class Unread extends Error {
  readonly field: string
  readonly why: string
  constructor(field: string, why: string) {
    super(why)
    this.field = field
    this.why = why
  }
}

const ABSENCE = /^(\d{4}-\d{2}-\d{2})\s*(?:→|->|to)?\s*(\d{4}-\d{2}-\d{2})\s*(.*)$/
const PAY_FLOOR = /^(\d+(?:\.\d+)?)\s+([A-Za-z]{3})\s+(?:per\s+|\/\s*)?(hour|year)$/i

function absencesOf(text: string): Profile['absences'] {
  return listOf(text).map((line, at) => {
    const match = ABSENCE.exec(line)
    if (match === null) throw new Unread('absences', `Line ${at + 1} is not «YYYY-MM-DD → YYYY-MM-DD label»`)
    return { from: match[1] ?? '', to: match[2] ?? '', label: (match[3] ?? '').trim() }
  })
}

function payFloorOf(text: string, field: string): Goal['payFloor'] {
  if (text.trim() === '') return null
  const match = PAY_FLOOR.exec(text.trim())
  if (match === null) throw new Unread(field, 'A pay floor reads like «45 AUD per hour», or is empty')
  return { amount: Number(match[1]), currency: (match[2] ?? '').toUpperCase(), per: (match[3] ?? '').toLowerCase() === 'year' ? 'year' : 'hour' }
}

function wholeOf(text: string, field: string): number {
  if (!/^\d+$/.test(text.trim())) throw new Unread(field, 'A whole number')
  return Number(text.trim())
}

function goalsOf(form: ProfileForm, base: Profile): Profile['goals'] {
  return form.goals.map((goal, at) => ({
    id: base.goals[at]?.id ?? `goal-${at + 1}`,
    label: goal.label,
    enabled: goal.enabled,
    text: goal.text,
    payFloor: payFloorOf(goal.payFloor, `goals.${at}.payFloor`),
    sources: goal.sources
      .split(',')
      .map((source) => source.trim())
      .filter((source) => source !== ''),
  }))
}

/** The profile the form describes, or the first line that does not read. */
export function profileOf(form: ProfileForm, base: Profile): ProfileOutcome {
  try {
    const profile: Profile = {
      identity: form.identity,
      situation: form.situation,
      availability: form.availability,
      absences: absencesOf(form.absences),
      goals: goalsOf(form, base),
      level: form.level,
      redLines: { text: form.redLinesText, titleWords: listOf(form.titleWords), requirementWords: listOf(form.requirementWords), unpaid: form.unpaid, equityOnly: form.equityOnly },
      preferences: { text: form.preferencesText, rateExpectation: form.rateExpectation },
      forbiddenStacks: listOf(form.forbiddenStacks),
      confidential: listOf(form.confidential),
      batchSize: wholeOf(form.batchSize, 'batchSize'),
      weights: Object.fromEntries(Object.entries(form.weights).map(([key, value]) => [key, wholeOf(value, `weights.${key}`)])),
      followup: form.followup,
    }
    return { ok: true, profile }
  } catch (cause) {
    if (cause instanceof Unread) return { ok: false, field: cause.field, why: cause.why }
    throw cause
  }
}

/**
 * The form after a save came back: the saved profile — unless the owner typed while it was posted
 * (`now` is no longer the form that was posted): then their typing stays, to be saved next.
 */
export function afterSave(now: ProfileForm | null, posted: ProfileForm, saved: Profile): ProfileForm {
  return now === null || now === posted ? formOf(saved) : now
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** «Saved as version 4» (D15), and how many unsent applications the re-lint changed. */
export function savedLine(saved: { readonly version: number; readonly relinted: number }): string {
  const head = `Saved as version ${saved.version}`
  return saved.relinted === 0 ? head : `${head} · ${plural(saved.relinted, 'application')} re-checked`
}

/** The `field` of a `400 { error: { field } }`, read structurally; null when there is none. */
export function fieldOf(cause: unknown): string | null {
  const body = (cause as { readonly body?: unknown } | null)?.body as { readonly error?: { readonly field?: unknown } } | undefined
  const field = body?.error?.field
  return typeof field === 'string' ? field : null
}

/** Where on the page a field lives: the `id` the settings page gives it. */
const ANCHORS: Readonly<Record<string, string>> = {
  'identity.portfolioUrl': 'portfolio',
  'preferences.rateExpectation': 'rate',
  'preferences.text': 'preferences',
  'redLines.text': 'redLines',
}

export function anchorOfField(field: string): string {
  const known = ANCHORS[field]
  if (known !== undefined) return known
  const [head, next] = field.split('.')
  const anchor = head === 'identity' ? next : head
  return anchor !== undefined && /^[A-Za-z]{1,40}$/.test(anchor) ? anchor : 'identity'
}
