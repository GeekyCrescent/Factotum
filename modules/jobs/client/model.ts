/**
 * What the review screen decides (spec 2026-11-12-postulaciones, design D15; requirements crit.
 * 28b, 32–37). Pure, no DOM: tested by `node --test` and compiled by `modules/tsconfig.json`. The
 * components only draw what these functions say.
 *
 * THE ENGINE CHECKS AGAIN. Everything here is the screen's courtesy — a button off with its why — and
 * never the guard: `POST /batch/decide` answers `422 blocked` or `409 check-pending` on its own (crit.
 * 34). So a rule here may lag the engine by one poll and nothing worse happens than a refusal shown.
 */

import type {
  Address,
  ApplicationCard,
  BatchView,
  FormAnswer,
  ItemResult,
  RequestError,
  ReviewItem,
  SendKind,
  SendView,
  Warning,
  WarningCode,
} from './contract.ts'

export { addressControls, ADDRESS_STALE_DAYS, isStaleCheck, type AddressControls, type Toggle } from './address.ts'
import { addressControls, isStaleCheck } from './address.ts'

/** The instruction «Remove the portfolio line» sends, already written (D6, P4). */
export const REMOVE_PORTFOLIO = 'Remove the portfolio line and anything that refers to it'

const TELL_THE_AI = 'Tell the AI what to change'
const I_CHECKED_IT = 'I checked it'

// ── The exits of each block (D6 «Cómo se resuelve») ──────────────────────────────────────────────

export type Exit =
  /** To a section of the settings page: `/m/jobs/settings#<anchor>`. */
  | { readonly kind: 'settings'; readonly label: string; readonly anchor: string }
  /** The instruction box, with `text` written in it (`''`: just the focus). */
  | { readonly kind: 'instruct'; readonly label: string; readonly text: string }
  | { readonly kind: 'override'; readonly label: string; readonly code: WarningCode }
  | { readonly kind: 'retry'; readonly label: string; readonly job: 'cv' | 'letter' | 'reprint' }
  /** Not a button: what is happening. */
  | { readonly kind: 'status'; readonly label: string }
  | { readonly kind: 'switch-to-form'; readonly label: string; readonly enabled: boolean }
  | { readonly kind: 'switch-channel'; readonly label: string }
  | { readonly kind: 'skip'; readonly label: string }

export interface ExitContext {
  readonly entity: 'application' | 'followup'
  /** The URL «Switch to form» would use; null turns it off. */
  readonly formUrl: string | null
  /** An application's generations and reprint; a follow-up has none. */
  readonly jobs: ApplicationCard['jobs'] | undefined
}

const instruct: Exit = { kind: 'instruct', label: TELL_THE_AI, text: '' }
const override = (code: WarningCode): Exit => ({ kind: 'override', label: I_CHECKED_IT, code })

/** A settings anchor is a field name or nothing: a detail is never put in a URL as it came. */
const anchorOf = (detail: string): string => (/^[A-Za-z]{1,40}$/.test(detail) ? detail : 'identity')

const IDLE = { state: 'idle', reason: null } as const

function generation(job: 'cv' | 'letter', ctx: ExitContext): readonly Exit[] {
  const status = ctx.jobs?.[job] ?? IDLE
  if (status.state === 'pending') return [{ kind: 'status', label: 'generating…' }]
  const retry: Exit = { kind: 'retry', label: 'Retry', job }
  // v6 (M9): an instruction on a missing letter asks for a NEW letter with it in the prompt.
  return job === 'letter' ? [retry, instruct] : [retry]
}

function reprint(ctx: ExitContext): readonly Exit[] {
  const status = ctx.jobs?.reprint ?? IDLE
  if (status.state !== 'failed') return [{ kind: 'status', label: 'reprinting with your new contact…' }]
  return [
    { kind: 'status', label: `reprint failed: ${status.reason ?? 'unknown reason'}` },
    { kind: 'retry', label: 'Retry print', job: 'reprint' },
  ]
}

/** The address is a placeholder (v6, M7): never the AI, which does not know it. «Edit address» arrives with T2b. */
function addressPlaceholder(ctx: ExitContext): readonly Exit[] {
  if (ctx.entity === 'followup') return [{ kind: 'switch-channel', label: 'Switch to LinkedIn note' }]
  return [{ kind: 'switch-to-form', label: 'Switch to form', enabled: ctx.formUrl !== null }]
}

/** The exits beside one warning. Only a block has any; `requirement-gap` goes in «Gaps vs the ad». */
export function exitsFor(warning: Warning, ctx: ExitContext): readonly Exit[] {
  if (!warning.blocks) return []
  switch (warning.code) {
    case 'missing-phone':
      return [{ kind: 'settings', label: 'Add your phone', anchor: 'identity' }]
    case 'missing-profile-field':
      return [{ kind: 'settings', label: 'Add it in settings', anchor: anchorOf(warning.detail) }, instruct]
    case 'missing-portfolio':
      return [
        { kind: 'settings', label: 'Add a portfolio link', anchor: 'portfolio' },
        { kind: 'instruct', label: 'Remove the portfolio line', text: REMOVE_PORTFOLIO },
      ]
    case 'missing-cv':
      return generation('cv', ctx)
    case 'missing-letter':
      return generation('letter', ctx)
    case 'cv-stale':
      return reprint(ctx)
    case 'placeholder':
      return warning.where === 'to' ? addressPlaceholder(ctx) : [instruct]
    case 'unsupported-claim':
    case 'external-link':
      return [instruct, override(warning.code)]
    case 'ad-closed':
      return [{ kind: 'skip', label: 'Skip it' }, override(warning.code)]
    default:
      return [instruct]
  }
}

/** What still blocks: blocks, and nobody said «I checked it». */
export function blockersOf(warnings: readonly Warning[]): readonly Warning[] {
  return warnings.filter((warning) => warning.blocks && warning.overridden === null)
}

/** «Gaps vs the ad» (v4, N2): amber, informative, no exit. */
export function gapsOf(warnings: readonly Warning[]): readonly string[] {
  return warnings.filter((warning) => warning.code === 'requirement-gap').map((warning) => warning.detail)
}

// ── The item, whichever kind it is ───────────────────────────────────────────────────────────────

/** What an application and a follow-up have in common for the buttons. */
export interface Reviewable {
  readonly entity: 'application' | 'followup'
  readonly state: string
  readonly email: boolean
  readonly address: Address | null
  readonly formUrl: string | null
  readonly warnings: readonly Warning[]
  readonly jobs: ApplicationCard['jobs'] | undefined
}

export function reviewableOf(item: ReviewItem): Reviewable | null {
  if (item.kind === 'application' || (item.kind === 'rewritten' && item.target === 'application')) {
    const app = item.application
    const { state, warnings, formUrl, jobs } = app
    return { entity: 'application', state, email: app.channel === 'email', address: app.contact?.address ?? null, formUrl, warnings, jobs }
  }
  if (item.kind === 'followup' || item.kind === 'rewritten') {
    const followup = item.followup
    const { state, warnings } = followup
    return { entity: 'followup', state, email: followup.channel === 'email', address: followup.contact?.address ?? null, formUrl: null, warnings, jobs: undefined }
  }
  return null
}

export interface Gate {
  readonly enabled: boolean
  readonly why: string | null
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function stateGate(subject: Reviewable): Gate | null {
  if (subject.state === 'rewriting') return { enabled: false, why: 'rewriting…' }
  const blocks = blockersOf(subject.warnings).length
  if (blocks > 0) return { enabled: false, why: `${plural(blocks, 'block')} to resolve below` }
  if (subject.state === 'ready') return null
  // In review with nothing left to block: the engine re-lints it in a moment (D6 «Re-lint»).
  if (subject.state === 'in-review') return { enabled: false, why: 're-linting…' }
  return { enabled: false, why: `it is ${subject.state}` }
}

/** «Approve» and its why (crit. 34): decided, then the state and its blocks, then — email only — the address. */
export function approveGate(item: ReviewItem, result: ItemResult | undefined, now: Date): Gate {
  if (result !== undefined) return { enabled: false, why: result }
  const subject = reviewableOf(item)
  if (subject === null) return { enabled: false, why: null }
  const byState = stateGate(subject)
  if (byState !== null) return byState
  if (!subject.email) return { enabled: true, why: null }
  return addressControls(subject.address, { now, entity: subject.entity, formUrl: subject.formUrl }).approve
}

// ── Labels, the form ─────────────────────────────────────────────────────────────────────────────

export interface Label {
  readonly text: string
  readonly tone: 'plain' | 'amber' | 'red'
  /** The `detail`, on hover. */
  readonly title: string | null
}

/** Hours, channel, score, and one per warning: red if it blocks, amber if it warns or was checked (D15). */
export function labelsOf(app: Pick<ApplicationCard, 'hours' | 'channel' | 'score' | 'warnings'>): readonly Label[] {
  const plain = (text: string): Label => ({ text, tone: 'plain', title: null })
  const facts = [app.hours, app.channel, app.score === null ? null : `score ${app.score}`].filter((text): text is string => text !== null)
  const warnings = app.warnings
    .filter((warning) => warning.code !== 'requirement-gap')
    .map((warning): Label => {
      const blocking = warning.blocks && warning.overridden === null
      const text = warning.overridden === null ? warning.code : `${warning.code} ✓`
      return { text, tone: blocking ? 'red' : 'amber', title: warning.detail }
    })
  return [...facts.map(plain), ...warnings]
}

const PLACEHOLDER = /\[[^\]\n]{1,80}\]|\bTODO\b|\bTBD\b|\{[A-Za-z]+\}/

/** ⚠ when the answer is not ok, empty, or still carries a placeholder; ✓ otherwise (D15). */
export function formMark(answer: FormAnswer): '✓' | '⚠' {
  return answer.ok && answer.answer.trim() !== '' && !PLACEHOLDER.test(answer.answer) ? '✓' : '⚠'
}

// ── The batch ────────────────────────────────────────────────────────────────────────────────────

export type Dot = 'done' | 'current' | 'open'

export interface Header {
  /** «2 of 10». */
  readonly label: string
  readonly dots: readonly Dot[]
  readonly test: boolean
}

export function headerOf(batch: BatchView, index: number): Header {
  const dots = batch.items.map((item, at): Dot => (at === index ? 'current' : batch.results[item.itemId] === undefined ? 'open' : 'done'))
  return { label: `${index + 1} of ${batch.items.length}`, dots, test: batch.test }
}

/** The first undecided item from `from` on, wrapping round; -1 when every item has its result. */
export function nextOpen(batch: BatchView, from: number): number {
  const count = batch.items.length
  for (let step = 0; step < count; step += 1) {
    const at = (from + step) % count
    const item = batch.items[at]
    if (item !== undefined && batch.results[item.itemId] === undefined) return at
  }
  return -1
}

export const isBatchDone = (batch: BatchView): boolean => nextOpen(batch, 0) === -1

export interface Summary {
  readonly approved: number
  readonly sent: number
  readonly skipped: number
  readonly instructed: number
  /** Still rewriting: they come back at the end (crit. 32). */
  readonly rewriting: number
  /** More `ready` outside this batch: «Start next batch». */
  readonly nextBatch: boolean
}

/** The end of the batch (crit. 37). */
export function batchSummary(batch: BatchView, ready: number): Summary {
  const count = (result: ItemResult): number => Object.values(batch.results).filter((value) => value === result).length
  return {
    approved: count('approved'),
    sent: count('sent'),
    skipped: count('skipped'),
    instructed: count('instructed'),
    rewriting: batch.rewriting,
    nextBatch: ready > 0,
  }
}

/** An undecided email whose address waits for a check keeps the batch polled, as a rewrite does (D15). */
function waitsForCheck(item: ReviewItem, batch: BatchView, now: Date): boolean {
  if (batch.results[item.itemId] !== undefined) return false
  const subject = reviewableOf(item)
  if (subject === null || !subject.email || subject.address === null) return false
  return subject.address.status === 'checking' || isStaleCheck(subject.address, now)
}

export function shouldPollBatch(batch: BatchView, now: Date): boolean {
  return batch.rewriting > 0 || batch.items.some((item) => waitsForCheck(item, batch, now))
}

// ── The send line (D9 paso 4) ────────────────────────────────────────────────────────────────────

export interface SendKey {
  readonly applicationId: string
  readonly kind: SendKind
  readonly company: string
}

/** The send an approve starts, for `GET /a/:id/sends/:kind`; null when approving sends nothing (manual channels). */
export function sendKeyOf(item: ReviewItem): SendKey | null {
  if (item.kind === 'application' || (item.kind === 'rewritten' && item.target === 'application')) {
    const app = item.application
    return app.channel === 'email' ? { applicationId: app.id, kind: 'initial', company: app.company.name } : null
  }
  if (item.kind === 'followup' || item.kind === 'rewritten') {
    const followup = item.followup
    if (followup.channel !== 'email') return null
    return { applicationId: followup.applicationId, kind: `followup-${followup.n}`, company: followup.company.name }
  }
  return null
}

export interface SendLine {
  readonly text: string
  readonly tone: 'pending' | 'ok' | 'err' | 'ask'
  /** Stop polling. */
  readonly final: boolean
  readonly retry: boolean
}

/** «Sending to Acme…» → «Sent ✓», or the reason with «Retry», or «did it go?». */
export function sendLine(send: SendView, company: string): SendLine {
  switch (send.state) {
    case 'sending':
      return { text: `Sending to ${company}…`, tone: 'pending', final: false, retry: false }
    case 'sent':
      return { text: `Sent to ${company} ✓`, tone: 'ok', final: true, retry: false }
    case 'failed':
      return { text: `${company}: ${send.reason ?? 'the send failed'}`, tone: 'err', final: true, retry: true }
    case 'send-unknown':
      return { text: `${company}: did it go?`, tone: 'ask', final: true, retry: false }
  }
}

// ── A refused decision (D3 «Qué responde el motor», crit. 34) ────────────────────────────────────

/** The status of a failed request, read structurally (`apps/web/src/api.ts` `readResponse`). */
export function statusOf(cause: unknown): number | undefined {
  const status = (cause as RequestError | null)?.status
  return typeof status === 'number' ? status : undefined
}

export interface Refusal {
  readonly text: string
  /** `409 check-pending`: the engine queued the check; the batch poll brings the answer. */
  readonly retryLater: boolean
}

const REASONS: Readonly<Record<string, string>> = {
  'address-unverified': 'The address was not found on their site: Send anyway, or Switch to form.',
  'no-address': 'There is no address to send to.',
}

export function refusalOf(cause: unknown): Refusal {
  const message = cause instanceof Error ? cause.message : undefined
  if (message === undefined) return { text: 'Something went wrong.', retryLater: false }
  if (statusOf(cause) === 409 && message === 'check-pending') return { text: 'checking address… try again in a moment', retryLater: true }
  return { text: REASONS[message] ?? message, retryLater: false }
}

// ── Links ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A URL that came from data (an ad, a package) as an `href`: only `http(s)`, so a tampered row can
 * never draw a `javascript:` link; with `prefix`, only under it (Gmail's links go to Gmail).
 */
export function safeHref(url: string | null, prefix?: string): string | null {
  if (url === null || !/^https?:\/\//i.test(url)) return null
  return prefix === undefined || url.startsWith(prefix) ? url : null
}

// ── The keys (crit. 36) ──────────────────────────────────────────────────────────────────────────

export type KeyAction = 'approve' | 'skip' | 'back' | 'focus'

export interface KeyPress {
  readonly key: string
  /** The focus is in an input, a textarea or something editable. */
  readonly inField: boolean
  /** Ctrl, Meta or Alt held. */
  readonly modified: boolean
}

const KEYS: Readonly<Record<string, KeyAction>> = { a: 'approve', s: 'skip', arrowleft: 'back', '/': 'focus' }

export function keyAction(press: KeyPress): KeyAction | null {
  if (press.inField || press.modified) return null
  return KEYS[press.key.toLowerCase()] ?? null
}
