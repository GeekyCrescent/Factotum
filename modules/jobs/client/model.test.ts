import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Address, ApplicationCard, BatchView, FollowupCard, ReviewItem, SendView, Warning, WarningCode } from './contract.ts'
import {
  REMOVE_PORTFOLIO,
  addressControls,
  approveGate,
  batchSummary,
  blockersOf,
  exitsFor,
  formMark,
  gapsOf,
  headerOf,
  isBatchDone,
  keyAction,
  labelsOf,
  nextOpen,
  refusalOf,
  sendKeyOf,
  statusOf,
  sendLine,
  shouldPollBatch,
  type Exit,
} from './model.ts'

const NOW = new Date('2026-11-13T10:00:00.000Z')
const TODAY = '2026-11-13T08:00:00.000Z'
const DAYS_AGO_15 = '2026-10-29T08:00:00.000Z'

const warning = (code: WarningCode, over: Partial<Warning> = {}): Warning => ({
  code,
  where: 'letter',
  detail: `${code} detail`,
  blocks: true,
  overridden: null,
  ...over,
})

const address = (over: Partial<Address>): Address => ({ status: 'verified', verifiedUrl: 'https://acme.io', checkedAt: TODAY, override: null, ...over })

const IDLE = { state: 'idle', reason: null } as const

function application(over: Partial<ApplicationCard> = {}): ApplicationCard {
  return {
    id: 'app-1',
    state: 'ready',
    channel: 'email',
    test: false,
    version: 2,
    company: { id: 'c-1', name: 'Acme' },
    role: 'Developer',
    hours: 'part-time',
    score: 82,
    adUrl: 'https://acme.io/job',
    formUrl: 'https://acme.io/apply',
    contact: { id: 'k-1', name: 'Sean', email: 'sean@acme.io', address: address({}) },
    to: 'sean@acme.io',
    letter: { subject: 'Hello', body: 'Hi Sean' },
    form: [],
    linkedin: null,
    cv: { base: 'B', png: 'a/app-1/v/2/preview.png', pdf: 'a/app-1/v/2/cv.pdf', tailored: null },
    notes: '',
    warnings: [],
    jobs: { cv: IDLE, letter: IDLE, reprint: IDLE },
    sends: [],
    ...over,
  }
}

function followup(over: Partial<FollowupCard> = {}): FollowupCard {
  return {
    id: 'f-1',
    applicationId: 'app-1',
    n: 1,
    state: 'ready',
    channel: 'email',
    company: { id: 'c-1', name: 'Acme' },
    role: 'Developer',
    contact: { id: 'k-1', name: 'Sean', email: 'sean@acme.io', address: address({}) },
    to: 'sean@acme.io',
    subject: 'Following up',
    body: 'Hi again',
    warnings: [],
    ...over,
  }
}

const appItem = (over: Partial<ApplicationCard> = {}, itemId = 'i-1'): ReviewItem => ({ itemId, kind: 'application', application: application(over) })
const followupItem = (over: Partial<FollowupCard> = {}, itemId = 'i-f'): ReviewItem => ({ itemId, kind: 'followup', followup: followup(over) })

function batch(items: readonly ReviewItem[], results: BatchView['results'] = {}, over: Partial<BatchView> = {}): BatchView {
  return { id: 'b-1', test: false, items, cursor: 0, results, rewriting: 0, ...over }
}

const labels = (exits: readonly Exit[]): readonly string[] => exits.map((exit) => exit.label)
const appCtx = { entity: 'application', formUrl: 'https://acme.io/apply', jobs: application().jobs } as const

// ── The exits of each block (D6 «Cómo se resuelve») ──────────────────────────────────────────────

test('missing-portfolio gives exactly «Add a portfolio link» and «Remove the portfolio line», the instruction already written (P4)', () => {
  const exits = exitsFor(warning('missing-portfolio', { detail: 'portfolioUrl' }), appCtx)
  assert.deepEqual(exits, [
    { kind: 'settings', label: 'Add a portfolio link', anchor: 'portfolio' },
    { kind: 'instruct', label: 'Remove the portfolio line', text: 'Remove the portfolio line and anything that refers to it' },
  ])
  assert.equal(REMOVE_PORTFOLIO, 'Remove the portfolio line and anything that refers to it')
})

test('a placeholder in `to` gives «Switch to form» and NEVER an instruction to the AI (v6, M7)', () => {
  const exits = exitsFor(warning('placeholder', { where: 'to', detail: '[email]' }), appCtx)
  assert.deepEqual(exits, [{ kind: 'switch-to-form', label: 'Switch to form', enabled: true }])
  assert.ok(exits.every((exit) => exit.kind !== 'instruct'))
})

test('a placeholder in `to` without a form URL: «Switch to form» is there but off', () => {
  assert.deepEqual(exitsFor(warning('placeholder', { where: 'to' }), { ...appCtx, formUrl: null }), [
    { kind: 'switch-to-form', label: 'Switch to form', enabled: false },
  ])
})

test('a placeholder in a follow-up\'s `to`: «Switch to LinkedIn note», never the AI', () => {
  const exits = exitsFor(warning('placeholder', { where: 'to' }), { entity: 'followup', formUrl: null, jobs: undefined })
  assert.deepEqual(exits, [{ kind: 'switch-channel', label: 'Switch to LinkedIn note' }])
})

test('a placeholder in a text is an instruction to the AI', () => {
  assert.deepEqual(exitsFor(warning('placeholder'), appCtx), [{ kind: 'instruct', label: 'Tell the AI what to change', text: '' }])
})

test('missing-phone links to the identity section of settings', () => {
  assert.deepEqual(exitsFor(warning('missing-phone'), appCtx), [{ kind: 'settings', label: 'Add your phone', anchor: 'identity' }])
})

test('missing-profile-field links to its field, and the AI can drop the answer instead', () => {
  assert.deepEqual(labels(exitsFor(warning('missing-profile-field', { detail: 'suburb' }), appCtx)), ['Add it in settings', 'Tell the AI what to change'])
  assert.deepEqual(exitsFor(warning('missing-profile-field', { detail: 'timezone' }), appCtx)[0], {
    kind: 'settings',
    label: 'Add it in settings',
    anchor: 'timezone',
  })
  // A detail that is not a field name never reaches the URL.
  assert.deepEqual(exitsFor(warning('missing-profile-field', { detail: 'a b/../x' }), appCtx)[0], { kind: 'settings', label: 'Add it in settings', anchor: 'identity' })
})

test('missing-cv: «generating…» while asked, «Retry» once it failed', () => {
  const pending = { ...appCtx, jobs: { ...appCtx.jobs, cv: { state: 'pending', reason: null } } } as const
  const failed = { ...appCtx, jobs: { ...appCtx.jobs, cv: { state: 'failed', reason: 'timeout' } } } as const
  assert.deepEqual(exitsFor(warning('missing-cv'), pending), [{ kind: 'status', label: 'generating…' }])
  assert.deepEqual(exitsFor(warning('missing-cv'), failed), [{ kind: 'retry', label: 'Retry', job: 'cv' }])
  assert.deepEqual(exitsFor(warning('missing-cv'), appCtx), [{ kind: 'retry', label: 'Retry', job: 'cv' }])
})

test('missing-letter: «generating…» or «Retry» of a LETTER, and an instruction (v6, M9)', () => {
  const pending = { ...appCtx, jobs: { ...appCtx.jobs, letter: { state: 'pending', reason: null } } } as const
  assert.deepEqual(exitsFor(warning('missing-letter'), pending), [{ kind: 'status', label: 'generating…' }])
  assert.deepEqual(exitsFor(warning('missing-letter'), appCtx), [
    { kind: 'retry', label: 'Retry', job: 'letter' },
    { kind: 'instruct', label: 'Tell the AI what to change', text: '' },
  ])
})

test('cv-stale: «reprinting…» while it runs, «Retry print» with the reason once it failed (A6)', () => {
  assert.deepEqual(exitsFor(warning('cv-stale'), appCtx), [{ kind: 'status', label: 'reprinting with your new contact…' }])
  const failed = { ...appCtx, jobs: { ...appCtx.jobs, reprint: { state: 'failed', reason: 'chromium exited 1' } } } as const
  assert.deepEqual(exitsFor(warning('cv-stale'), failed), [
    { kind: 'status', label: 'reprint failed: chromium exited 1' },
    { kind: 'retry', label: 'Retry print', job: 'reprint' },
  ])
})

test('unsupported-claim and external-link: the AI or «I checked it»', () => {
  for (const code of ['unsupported-claim', 'external-link'] as const) {
    assert.deepEqual(exitsFor(warning(code), appCtx), [
      { kind: 'instruct', label: 'Tell the AI what to change', text: '' },
      { kind: 'override', label: 'I checked it', code },
    ])
  }
})

test('the text blocks are the AI only: no «I checked it» outside the verifier and links', () => {
  for (const code of ['confidential-name', 'health-keyword', 'health-mentions', 'forbidden-stack', 'unknown-number', 'cv-overflow'] as const) {
    assert.deepEqual(labels(exitsFor(warning(code), appCtx)), ['Tell the AI what to change'], code)
  }
})

test('ad-closed (not in the D6 table): skip it, or «I checked it» when the ad is still up', () => {
  assert.deepEqual(exitsFor(warning('ad-closed'), appCtx), [
    { kind: 'skip', label: 'Skip it' },
    { kind: 'override', label: 'I checked it', code: 'ad-closed' },
  ])
})

test('what does not block has no exit (requirement-gap, too-long, senior-title)', () => {
  for (const code of ['requirement-gap', 'too-long', 'senior-title'] as const) {
    assert.deepEqual(exitsFor(warning(code, { blocks: false }), appCtx), [], code)
  }
})

test('the blocks are those that block and are not overridden', () => {
  const kept = warning('placeholder')
  const list = [kept, warning('unsupported-claim', { overridden: { at: TODAY } }), warning('too-long', { blocks: false })]
  assert.deepEqual(blockersOf(list), [kept])
})

// ── The address buttons (D3 «La dirección no bloquea la revisión») ───────────────────────────────

const email = { now: NOW, entity: 'application', formUrl: 'https://acme.io/apply' } as const

test('address verified today: Approve on, nothing else', () => {
  assert.deepEqual(addressControls(address({}), email), {
    label: 'verified',
    approve: { enabled: true, why: null },
    sendAnyway: 'hidden',
    switchChannel: 'hidden',
  })
})

test('address verified but old: Approve off with «re-checking…», nothing else (v6, N2)', () => {
  assert.deepEqual(addressControls(address({ checkedAt: DAYS_AGO_15 }), email), {
    label: 're-checking…',
    approve: { enabled: false, why: 're-checking…' },
    sendAnyway: 'hidden',
    switchChannel: 'hidden',
  })
})

test('address checking: Approve and Send anyway off with «checking address…», Switch to form on with a URL', () => {
  assert.deepEqual(addressControls(address({ status: 'checking', checkedAt: null }), email), {
    label: 'checking…',
    approve: { enabled: false, why: 'checking address…' },
    sendAnyway: 'off',
    switchChannel: 'on',
  })
  assert.equal(addressControls(address({ status: 'checking' }), { ...email, formUrl: null }).switchChannel, 'off')
})

test('address unverified and never checked: both off until the check ends', () => {
  assert.deepEqual(addressControls(address({ status: 'unverified', checkedAt: null }), email), {
    label: 'checking…',
    approve: { enabled: false, why: 'checking address…' },
    sendAnyway: 'off',
    switchChannel: 'on',
  })
})

test('address unverified after a check: Approve off, Send anyway on (second click), Switch to form on', () => {
  assert.deepEqual(addressControls(address({ status: 'unverified', checkedAt: TODAY }), email), {
    label: 'unverified',
    approve: { enabled: false, why: 'address not found on their site' },
    sendAnyway: 'on',
    switchChannel: 'on',
  })
})

test('address unverified with an override: Approve on, «sent anyway»', () => {
  assert.deepEqual(addressControls(address({ status: 'unverified', checkedAt: TODAY, override: { at: TODAY } }), email), {
    label: 'sent anyway',
    approve: { enabled: true, why: null },
    sendAnyway: 'hidden',
    switchChannel: 'hidden',
  })
})

test('an old check with an override is re-checked first, as the engine does (v5, X4 last row)', () => {
  const controls = addressControls(address({ status: 'unverified', checkedAt: DAYS_AGO_15, override: { at: DAYS_AGO_15 } }), email)
  assert.deepEqual(controls.approve, { enabled: false, why: 're-checking…' })
  assert.equal(controls.sendAnyway, 'off')
})

test('no address at all: Approve off, Switch to form on with a URL', () => {
  assert.deepEqual(addressControls(null, email), {
    label: 'no address',
    approve: { enabled: false, why: 'no address' },
    sendAnyway: 'hidden',
    switchChannel: 'on',
  })
})

test('a follow-up switches to a LinkedIn note, URL or not', () => {
  const controls = addressControls(address({ status: 'unverified', checkedAt: TODAY }), { now: NOW, entity: 'followup', formUrl: null })
  assert.equal(controls.switchChannel, 'on')
})

// ── Approve and its why (crit. 34) ───────────────────────────────────────────────────────────────

test('a clean, ready email to a verified address can be approved', () => {
  assert.deepEqual(approveGate(appItem(), undefined, NOW), { enabled: true, why: null })
})

test('a blocked item: Approve off, saying how many blocks are below', () => {
  const item = appItem({ state: 'in-review', warnings: [warning('missing-portfolio'), warning('placeholder')] })
  assert.deepEqual(approveGate(item, undefined, NOW), { enabled: false, why: '2 blocks to resolve below' })
  const one = appItem({ state: 'in-review', warnings: [warning('missing-portfolio')] })
  assert.deepEqual(approveGate(one, undefined, NOW), { enabled: false, why: '1 block to resolve below' })
})

test('the blocks come before the address in the why', () => {
  const item = appItem({ state: 'in-review', warnings: [warning('placeholder')], contact: { id: 'k', name: null, email: 'x@y.io', address: address({ status: 'checking' }) } })
  assert.equal(approveGate(item, undefined, NOW).why, '1 block to resolve below')
})

test('a ready email whose address is still being checked: off with «checking address…»', () => {
  const item = appItem({ contact: { id: 'k', name: null, email: 'x@y.io', address: address({ status: 'checking' }) } })
  assert.deepEqual(approveGate(item, undefined, NOW), { enabled: false, why: 'checking address…' })
})

test('a form ignores the address: Approve opens the assist panel', () => {
  const item = appItem({ channel: 'form', contact: null, to: null })
  assert.deepEqual(approveGate(item, undefined, NOW), { enabled: true, why: null })
})

test('an item already decided is read-only, saying what happened (crit. 35)', () => {
  assert.deepEqual(approveGate(appItem(), 'skipped', NOW), { enabled: false, why: 'skipped' })
})

test('an item not ready for another reason says which', () => {
  assert.deepEqual(approveGate(appItem({ state: 'rewriting' }), undefined, NOW), { enabled: false, why: 'rewriting…' })
  assert.deepEqual(approveGate(appItem({ state: 'in-review' }), undefined, NOW), { enabled: false, why: 're-linting…' })
  assert.deepEqual(approveGate(appItem({ state: 'sending' }), undefined, NOW), { enabled: false, why: 'it is sending' })
})

test('a follow-up draft with its block, and a ready one', () => {
  assert.deepEqual(approveGate(followupItem({ state: 'draft', warnings: [warning('placeholder', { where: 'to' })] }), undefined, NOW), {
    enabled: false,
    why: '1 block to resolve below',
  })
  assert.deepEqual(approveGate(followupItem(), undefined, NOW), { enabled: true, why: null })
  assert.deepEqual(approveGate(followupItem({ channel: 'linkedin', contact: null }), undefined, NOW), { enabled: true, why: null })
  assert.deepEqual(approveGate(followupItem({ state: 'rewriting' }), undefined, NOW), { enabled: false, why: 'rewriting…' })
  assert.deepEqual(approveGate(followupItem({ state: 'sent' }), undefined, NOW), { enabled: false, why: 'it is sent' })
})

test('a rewritten item is approved like the item it carries', () => {
  const rewrite = { fromVersion: 1, failed: false, instruction: 'shorter', reason: null, before: 'a b' }
  const item: ReviewItem = { itemId: 'r', kind: 'rewritten', target: 'application', application: application(), rewrite }
  assert.deepEqual(approveGate(item, undefined, NOW), { enabled: true, why: null })
  const back: ReviewItem = { itemId: 'r2', kind: 'rewritten', target: 'followup', followup: followup({ state: 'draft', warnings: [warning('placeholder')] }), rewrite }
  assert.equal(approveGate(back, undefined, NOW).enabled, false)
})

test('a reply or a proposal has no Approve', () => {
  const reply: ReviewItem = {
    itemId: 'r',
    kind: 'reply',
    reply: { applicationId: 'a', eventId: 'e', company: { id: 'c', name: 'Acme' }, from: 'x', subject: 's', summary: 'y', link: null },
  }
  assert.deepEqual(approveGate(reply, undefined, NOW), { enabled: false, why: null })
  assert.deepEqual(approveGate({ itemId: 'p', kind: 'proposal', proposalId: 'p' }, undefined, NOW), { enabled: false, why: null })
})

// ── The labels, the form, the gaps ───────────────────────────────────────────────────────────────

test('labels: hours, channel, score, and one per warning — red if it blocks, amber if not; the gaps apart', () => {
  const item = application({
    warnings: [
      warning('placeholder'),
      warning('too-long', { blocks: false, detail: 'letter 260 words' }),
      warning('unsupported-claim', { overridden: { at: TODAY } }),
      warning('requirement-gap', { blocks: false, where: 'ad', detail: 'Kubernetes' }),
    ],
  })
  assert.deepEqual(labelsOf(item), [
    { text: 'part-time', tone: 'plain', title: null },
    { text: 'email', tone: 'plain', title: null },
    { text: 'score 82', tone: 'plain', title: null },
    { text: 'placeholder', tone: 'red', title: 'placeholder detail' },
    { text: 'too-long', tone: 'amber', title: 'letter 260 words' },
    { text: 'unsupported-claim ✓', tone: 'amber', title: 'unsupported-claim detail' },
  ])
  assert.deepEqual(gapsOf(item.warnings), ['Kubernetes'])
})

test('labels skip what the item does not have', () => {
  assert.deepEqual(labelsOf(application({ hours: null, score: null, channel: 'linkedin' })), [{ text: 'linkedin', tone: 'plain', title: null }])
})

test('a form answer is ⚠ when not ok, empty, or with a placeholder; ✓ otherwise', () => {
  const answer = (text: string, ok = true) => ({ question: 'q', answer: text, ok, hint: null })
  assert.equal(formMark(answer('Sydney')), '✓')
  assert.equal(formMark(answer('Sydney', false)), '⚠')
  assert.equal(formMark(answer('  ')), '⚠')
  assert.equal(formMark(answer('[your salary]')), '⚠')
  assert.equal(formMark(answer('TBD')), '⚠')
  assert.equal(formMark(answer('see {portfolio}')), '⚠')
})

// ── The batch: header, moving on, the end (crit. 35, 37) ─────────────────────────────────────────

const three = [appItem({}, 'a'), appItem({}, 'b'), appItem({}, 'c')]

test('the header: «2 of 10» and one dot per item', () => {
  assert.deepEqual(headerOf(batch(three, { a: 'approved' }), 1), { label: '2 of 3', dots: ['done', 'current', 'open'], test: false })
  assert.deepEqual(headerOf(batch(three, {}, { test: true }), 0).test, true)
})

test('the next open item skips what is decided; none left is -1', () => {
  assert.equal(nextOpen(batch(three, { a: 'approved', b: 'skipped' }), 0), 2)
  assert.equal(nextOpen(batch(three, { c: 'sent' }), 2), 0)
  assert.equal(nextOpen(batch(three, { a: 'approved', b: 'skipped', c: 'instructed' }), 0), -1)
})

test('done when every item has a result', () => {
  assert.equal(isBatchDone(batch(three, { a: 'approved', b: 'skipped' })), false)
  assert.equal(isBatchDone(batch(three, { a: 'approved', b: 'skipped', c: 'sent' })), true)
})

test('the end of the batch: approved, sent, skipped, rewriting, and «Start next batch» when more are ready (crit. 37)', () => {
  const view = batch([...three, appItem({}, 'd')], { a: 'approved', b: 'sent', c: 'skipped', d: 'instructed' }, { rewriting: 1 })
  assert.deepEqual(batchSummary(view, 4), { approved: 1, sent: 1, skipped: 1, instructed: 1, rewriting: 1, nextBatch: true })
  assert.equal(batchSummary(view, 0).nextBatch, false)
})

test('the batch is polled while something rewrites or an address is being checked', () => {
  assert.equal(shouldPollBatch(batch(three), NOW), false)
  assert.equal(shouldPollBatch(batch(three, {}, { rewriting: 1 }), NOW), true)
  const checking = appItem({ contact: { id: 'k', name: null, email: 'x@y.io', address: address({ status: 'checking' }) } }, 'x')
  assert.equal(shouldPollBatch(batch([checking]), NOW), true)
  const unchecked = followupItem({ contact: { id: 'k', name: null, email: 'x@y.io', address: address({ status: 'unverified', checkedAt: null }) } })
  assert.equal(shouldPollBatch(batch([unchecked]), NOW), true)
  const stale = appItem({ contact: { id: 'k', name: null, email: 'x@y.io', address: address({ checkedAt: DAYS_AGO_15 }) } }, 's')
  assert.equal(shouldPollBatch(batch([stale]), NOW), true)
  // Decided items, and forms, do not keep it polling.
  assert.equal(shouldPollBatch(batch([checking], { x: 'skipped' }), NOW), false)
  assert.equal(shouldPollBatch(batch([appItem({ channel: 'form', contact: null }, 'f')]), NOW), false)
})

// ── The send line (D9 paso 4) ────────────────────────────────────────────────────────────────────

const send = (over: Partial<SendView>): SendView => ({ kind: 'initial', state: 'sending', at: TODAY, reason: null, ...over })

test('the send line: «Sending to Acme…» → «Sent ✓», or the reason with Retry, or «did it go?»', () => {
  assert.deepEqual(sendLine(send({}), 'Acme'), { text: 'Sending to Acme…', tone: 'pending', final: false, retry: false })
  assert.deepEqual(sendLine(send({ state: 'sent' }), 'Acme'), { text: 'Sent to Acme ✓', tone: 'ok', final: true, retry: false })
  assert.deepEqual(sendLine(send({ state: 'failed', reason: '535 auth' }), 'Acme'), { text: 'Acme: 535 auth', tone: 'err', final: true, retry: true })
  assert.deepEqual(sendLine(send({ state: 'failed' }), 'Acme'), { text: 'Acme: the send failed', tone: 'err', final: true, retry: true })
  assert.deepEqual(sendLine(send({ state: 'send-unknown' }), 'Acme'), { text: 'Acme: did it go?', tone: 'ask', final: true, retry: false })
})

test('the send an item makes: the initial for an application, followup-n for a follow-up', () => {
  assert.deepEqual(sendKeyOf(appItem()), { applicationId: 'app-1', kind: 'initial', company: 'Acme' })
  assert.deepEqual(sendKeyOf(followupItem({ n: 2 })), { applicationId: 'app-1', kind: 'followup-2', company: 'Acme' })
  assert.equal(sendKeyOf(appItem({ channel: 'form' })), null)
  assert.equal(sendKeyOf(followupItem({ channel: 'linkedin' })), null)
  assert.equal(sendKeyOf({ itemId: 'p', kind: 'proposal', proposalId: 'p' }), null)
})

// ── The keys (crit. 36) ──────────────────────────────────────────────────────────────────────────

test('A approves, S skips, ← goes back, / focuses the box', () => {
  const key = (k: string, over: Partial<Parameters<typeof keyAction>[0]> = {}) => keyAction({ key: k, inField: false, modified: false, ...over })
  assert.equal(key('a'), 'approve')
  assert.equal(key('A'), 'approve')
  assert.equal(key('s'), 'skip')
  assert.equal(key('ArrowLeft'), 'back')
  assert.equal(key('/'), 'focus')
  assert.equal(key('x'), null)
})

// ── What a refused decision says (D3 «Qué responde el motor», crit. 34) ──────────────────────────

test('a refused decision says why, in the owner\'s words', () => {
  const error = (status: number, message: string) => Object.assign(new Error(message), { status })
  assert.deepEqual(refusalOf(error(409, 'check-pending')), { text: 'checking address… try again in a moment', retryLater: true })
  assert.deepEqual(refusalOf(error(422, 'address-unverified')), {
    text: 'The address was not found on their site: Send anyway, or Switch to form.',
    retryLater: false,
  })
  assert.deepEqual(refusalOf(error(422, 'no-address')), { text: 'There is no address to send to.', retryLater: false })
  assert.deepEqual(refusalOf(error(422, 'blocked by placeholder')), { text: 'blocked by placeholder', retryLater: false })
  assert.deepEqual(refusalOf(error(0, 'could not reach the daemon')), { text: 'could not reach the daemon', retryLater: false })
  assert.deepEqual(refusalOf('boom'), { text: 'Something went wrong.', retryLater: false })
  assert.equal(statusOf({ status: 404 }), 404)
  assert.equal(statusOf(null), undefined)
})

test('no key acts while typing in a field or with a modifier', () => {
  assert.equal(keyAction({ key: 'a', inField: true, modified: false }), null)
  assert.equal(keyAction({ key: '/', inField: true, modified: false }), null)
  assert.equal(keyAction({ key: 'a', inField: false, modified: true }), null)
})
