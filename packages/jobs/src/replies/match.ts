/**
 * Which application a mail in the inbox answers (design D12 «Emparejar»; tasks Q2). PURE: the reader
 * (`read.ts`) hands it the mail's headers and the world the store holds, and gets back one of the
 * four rules, IN ORDER:
 *
 * 1. THE THREAD. `In-Reply-To` or `References` carries the `messageId` of ANY row of `sends` — first
 *    send or follow-up, in any state (`sent`, `send-unknown`, `failed`: its current id, v6 M3; also
 *    `sending`, which Q4 turns into a deferred reply) — or one of the row's `attempts` (an earlier
 *    try before a «Retry», v5 X6: it may have gone out though SMTP said no). No cap on days, and
 *    whatever the application's state; THE TEST APPLICATION INCLUDED (v6.1).
 * 2. THE DOMAIN. The sender's domain, without `mail.`, `mg.` or `email.`, is the `domain` of a
 *    company with a CANDIDATE application → those candidates (one: that one; several: Claude picks).
 * 3. AN ATS OR JOB BOARD (`ATS_DOMAINS`, or a subdomain of one) → every candidate, for Claude.
 * 4. Otherwise NO BODY IS READ and nothing goes to Claude: a subject that looks like a job's
 *    (`JOB_SUBJECT`, `offer` included, v6 M5) is an «Unmatched reply»; anything else is ignored.
 *
 * A CANDIDATE (rules 2 and 3; v5 X1, v6 H2/M4/M5, v6.1 C1): an application in `send-unknown`,
 * `sent`, `replied` or `closed` THAT DID SEND (its `initial` row is `sent` or `send-unknown`), not the
 * test one, whose LAST ACTIVITY — its latest `sent`/`send-unknown` row, or its latest reply of a human
 * class, whichever is later; never the `closed` event — is within `REPLY_CANDIDATE_DAYS`.
 */

import type { Application, SendKind } from '../types.ts'

/** design D12: how long after its last activity an application still takes a reply by domain or ATS. */
export const REPLY_CANDIDATE_DAYS = 60

/** design D12 rule 3: the ATS and job boards that write on a company's behalf. */
export const ATS_DOMAINS: readonly string[] = [
  'seek.com.au',
  'myworkday.com',
  'greenhouse-mail.io',
  'lever.co',
  'ashbyhq.com',
  'bamboohr.com',
  'smartrecruiters.com',
  'breezy.hr',
  'dover.com',
  'workablemail.com',
]

/** design D12 rule 4 (v6, M5: `offer` too). */
export const JOB_SUBJECT = /application|interview|position|role|candidate|opportunity|offer/i

/** design D12 rule 2: the sending prefixes a company's mail platform adds to its domain. */
const SENDING_PREFIXES: readonly string[] = ['mail.', 'mg.', 'email.']

const DAY_MS = 24 * 60 * 60 * 1000

const CANDIDATE_STATES: ReadonlySet<Application['state']> = new Set<Application['state']>(['send-unknown', 'sent', 'replied', 'closed'])
/** A row in these states may have reached the company: it counts as having sent, and as activity. */
const WENT_OUT: ReadonlySet<string> = new Set(['sent', 'send-unknown'])

/** What the matcher reads of a mail: its headers, never its body. */
export interface MatchMail {
  readonly messageId: string | null
  /** The `<id>`s of `In-Reply-To`. */
  readonly inReplyTo: readonly string[]
  /** The `<id>`s of `References`. */
  readonly references: readonly string[]
  /** The sender's address, as the envelope gives it. */
  readonly from: string
  readonly subject: string
}

/** An application as the matcher sees it: with its sends, its company's domain and its latest human reply. */
export interface MatchApp {
  readonly application: Application
  readonly domain: string | null
  /** ISO: the `at` of its latest `reply` event of a human class, or null. */
  readonly lastHumanReplyAt: string | null
}

export interface MatchWorld {
  /** Every application with a row in `sends` (rule 1 reads them all; rules 2–3 their candidates). */
  readonly apps: readonly MatchApp[]
  readonly now: Date
}

export type ReplyMatch =
  /** Rule 1: the thread names this send (by its current `messageId`, or one of its `attempts`). */
  | { readonly kind: 'thread'; readonly rule: 1; readonly applicationId: string; readonly sendKind: SendKind; readonly viaAttempt: boolean }
  /** Rules 2–3: one or more candidates, in the store's order; Claude classifies (and picks, if several). */
  | { readonly kind: 'candidates'; readonly rule: 2 | 3; readonly applicationIds: readonly string[] }
  /** Rule 4, a job's subject: shown as «Unmatched reply», sender and subject only. */
  | { readonly kind: 'unmatched'; readonly rule: 4 }
  /** Rule 4, anything else. */
  | { readonly kind: 'ignored'; readonly rule: 4 }

const MESSAGE_ID = /<[^<>\s]+>/g

/** Every `<id>` in some header values, in order. A value with no brackets is one bare id. */
export function messageIdsIn(values: readonly string[]): readonly string[] {
  return values.flatMap((value) => {
    const found = value.match(MESSAGE_ID)
    if (found !== null) return found
    const bare = value.trim()
    return bare === '' || /\s/.test(bare) ? [] : [`<${bare}>`]
  })
}

/** The sender's domain, lower-cased, without one sending prefix (rule 2). Null when there is no `@`. */
export function senderDomain(address: string): string | null {
  const at = address.lastIndexOf('@')
  if (at === -1) return null
  const domain = address.slice(at + 1).trim().toLowerCase()
  const prefix = SENDING_PREFIXES.find((p) => domain.startsWith(p) && domain.length > p.length)
  return prefix === undefined ? domain : domain.slice(prefix.length)
}

const companyDomain = (domain: string | null): string | null => {
  const lower = domain?.trim().toLowerCase() ?? ''
  if (lower === '') return null
  return lower.startsWith('www.') ? lower.slice(4) : lower
}

const isAts = (domain: string): boolean => ATS_DOMAINS.some((ats) => domain === ats || domain.endsWith(`.${ats}`))

/** The latest activity of an application: its latest send that went out, or its latest human reply. */
function lastActivity(app: MatchApp): string | null {
  const times = [
    ...app.application.sends.filter((s) => WENT_OUT.has(s.state)).map((s) => s.at),
    ...(app.lastHumanReplyAt === null ? [] : [app.lastHumanReplyAt]),
  ]
  return times.length === 0 ? null : times.reduce((a, b) => (a > b ? a : b))
}

/** The candidates of rules 2 and 3, in the order given. */
export function replyCandidates(apps: readonly MatchApp[], now: Date): readonly MatchApp[] {
  const since = new Date(now.getTime() - REPLY_CANDIDATE_DAYS * DAY_MS).toISOString()
  return apps.filter((app) => {
    const { application } = app
    if (application.test || !CANDIDATE_STATES.has(application.state)) return false
    const initial = application.sends.find((s) => s.kind === 'initial')
    if (initial === undefined || !WENT_OUT.has(initial.state)) return false
    const last = lastActivity(app)
    return last !== null && last >= since
  })
}

/** Rule 1: the first send, in the store's order, whose current id or an attempt's the thread names. */
function byThread(mail: MatchMail, apps: readonly MatchApp[]): ReplyMatch | undefined {
  const named = new Set([...mail.inReplyTo, ...mail.references])
  if (named.size === 0) return undefined
  for (const { application } of apps) {
    for (const row of application.sends) {
      if (row.messageId !== null && named.has(row.messageId)) {
        return { kind: 'thread', rule: 1, applicationId: application.id, sendKind: row.kind, viaAttempt: false }
      }
      if (row.attempts.some((attempt) => named.has(attempt.messageId))) {
        return { kind: 'thread', rule: 1, applicationId: application.id, sendKind: row.kind, viaAttempt: true }
      }
    }
  }
  return undefined
}

export function matchReply(mail: MatchMail, world: MatchWorld): ReplyMatch {
  const thread = byThread(mail, world.apps)
  if (thread !== undefined) return thread

  const domain = senderDomain(mail.from)
  if (domain !== null) {
    const candidates = replyCandidates(world.apps, world.now)
    const ofDomain = candidates.filter((app) => companyDomain(app.domain) === domain)
    if (ofDomain.length > 0) return { kind: 'candidates', rule: 2, applicationIds: ofDomain.map((app) => app.application.id) }
    if (isAts(domain) && candidates.length > 0) {
      return { kind: 'candidates', rule: 3, applicationIds: candidates.map((app) => app.application.id) }
    }
  }
  return JOB_SUBJECT.test(mail.subject) ? { kind: 'unmatched', rule: 4 } : { kind: 'ignored', rule: 4 }
}
