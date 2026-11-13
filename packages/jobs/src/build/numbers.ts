/**
 * The «unknown number» rule of the linter (design D6; tasks L2). PURE.
 *
 * EVERY FIGURE OF THE CV AND THE LETTER MUST HAVE A SOURCE: `cv-maestro`, the profile, the ad
 * (`opportunity`), or the company's record (`company.record`, D8: the seeded fields that carry figures
 * — `employee_count`, `industry`, `requirements`, `responsibilities`, `fit`, `notes`, `salary`,
 * `sources[].what`). Without the record, the package's letters that quote the company's own figures
 * would all be blocked.
 *
 * NORMALISED BEFORE COMPARING: `1,069` is `1069`, `6×` is `6`, `40%` is `40`, `03` is `3`, `3.50` is
 * `3.5`; a range `16–20` and a date `2026-02-05` give each of their numbers. A digit glued to a
 * letter is part of a name (`EC2`, `HL7`, `COMP8300`, `v2`) and is not a figure; so is a whole version
 * token (`v2.0`, `v3.10.1`), minor parts included.
 *
 * A DURATION IN THE TEXT CHECKED IS NOT A CLAIM: «Could we have a 15-minute call?» asks, it does not
 * assert (R8). A figure directly followed by a minute, hour, day or week unit — hyphenated (`15-minute`,
 * `20-min`, `2-hour`, `5-day`, `6-weeks`) or after one space (`45 minutes`, `3 hours`, `10 days`) — is
 * not checked. Tight on purpose: months and years are not durations here (`13 years of experience` is a
 * claim), and only the text checked loses them — every figure of a source stays a source.
 */

import type { Opportunity, Profile } from '../types.ts'

export interface NumberSources {
  readonly master: string
  readonly profile: Profile
  readonly opportunity: Pick<Opportunity, 'title' | 'requirements' | 'salary' | 'hours' | 'duration'>
  readonly company: { readonly record: string }
}

/** A thousands-grouped figure, or plain digits; then an optional decimal part. Never after a letter or a digit. */
const FIGURE = /(?<![\p{L}\p{N}])(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?/gu

/** A version token, `v2.0` or `V3.10.1`: a name, not a figure — without this, its `.0` gave a `0`. */
const VERSION = /(?<![\p{L}\p{N}])v\d+(?:\.\d+)*/giu

/** A figure directly followed by a minute/hour/day/week unit (`15-minute`, `45 minutes`). */
const DURATION = /(?<![\p{L}\p{N}.,])\d+(?:\.\d+)?(?:-|\s)(?:min(?:ute)?s?|hours?|hrs?|days?|weeks?)(?![\p{L}\p{N}])/giu

const normalise = (figure: string): string => String(Number(figure.replace(/,/g, '')))

/** The figures of `text`, normalised, in the order they first appear, once each. */
export function numbersIn(text: string): readonly string[] {
  const withoutVersions = text.replace(VERSION, ' ')
  return [...new Set([...withoutVersions.matchAll(FIGURE)].map((m) => normalise(m[0])))]
}

/** Every string anywhere in `value`: the profile is free text in many fields. */
function stringsOf(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsOf)
  return []
}

function allowed(sources: NumberSources): ReadonlySet<string> {
  const { opportunity } = sources
  const ad = [opportunity.title, opportunity.requirements, opportunity.salary ?? '', opportunity.hours ?? '', opportunity.duration ?? '']
  const texts = [sources.master, ...stringsOf(sources.profile), ...ad, sources.company.record]
  return new Set(texts.flatMap(numbersIn))
}

/** The figures of `text` that no source has, in order, once each. */
export function unknownNumbers(text: string, sources: NumberSources): readonly string[] {
  const known = allowed(sources)
  return numbersIn(text.replace(DURATION, ' ')).filter((figure) => !known.has(figure))
}
