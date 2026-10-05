import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInboxConfig, type InboxConfig } from '../config.ts'
import type { Verdict } from '../classify/schema.ts'
import type { FetchedMail } from '../mail/fetch.ts'
import type { Digest } from '../types.ts'
import { assemble, gmailHex, keyOf, type AssembleInput, type BatchTally } from './assemble.ts'

const parsed = parseInboxConfig({
  model: 'haiku',
  accounts: [
    {
      id: 'personal',
      label: 'Gmail',
      host: 'imap.gmail.com',
      user: 'cuenta@gmail.com',
      passwordFile: '/secret',
      sources: [{ id: 'mq', label: 'Macquarie', address: 'me@students.mq.edu.au' }],
    },
    { id: 'other', label: 'Other', host: 'imap.example.com', user: 'o@example.com', passwordFile: '/secret2' },
  ],
})
if (!parsed.ok) throw new Error(parsed.reason)
const CONFIG: InboxConfig = parsed.config
const [PERSONAL, OTHER] = CONFIG.accounts as [InboxConfig['accounts'][number], InboxConfig['accounts'][number]]

const BODY_PHRASE = 'the secret phrase only the body holds'

function mail(uid: number, over: Partial<FetchedMail> = {}): FetchedMail {
  return {
    accountId: 'personal',
    sourceId: undefined,
    uid,
    messageId: `<m${uid}@x>`,
    gmailId: '1844674407370955161',
    from: 'Ana <ana@example.com>',
    subject: `subject ${uid}`,
    date: '2026-10-06T07:00:00.000Z',
    unsubscribe: false,
    attachments: 0,
    body: `${BODY_PHRASE} ${uid}`,
    ...over,
  }
}

const BATCHES: BatchTally = { total: 1, failed: 0, firstReason: undefined, inputTokens: 100, outputTokens: 10, costUsd: 0.01, model: 'claude-haiku-4-5-20251001' }

function input(over: Partial<AssembleInput> = {}): AssembleInput {
  const mails = [mail(1), mail(2, { sourceId: 'mq' })]
  const verdicts = new Map<string, Verdict>([
    [keyOf(mails[0]!), { category: 'action', priority: 'high', ask: 'reply', why: 'waiting', draft: 'Sí.' }],
    [keyOf(mails[1]!), { category: 'info', why: 'a notice' }],
  ])
  return {
    id: '2026-10-06T1800',
    startedAt: new Date('2026-10-06T07:00:00.000Z'),
    endedAt: new Date('2026-10-06T07:00:30.000Z'),
    since: new Date('2026-10-04T07:00:00.000Z'),
    config: CONFIG,
    accounts: [{ account: PERSONAL, ok: true, mails }],
    classified: mails,
    overflow: 0,
    verdicts,
    batches: BATCHES,
    timedOut: undefined,
    previous: undefined,
    ...over,
  }
}

test('no body in any entry: not by type, and not a phrase of it in the JSON (criterion 22)', () => {
  const digest = assemble(input())
  for (const entry of digest.entries) assert.equal('body' in entry, false)
  assert.equal(JSON.stringify(digest).includes(BODY_PHRASE), false)
})

test('an ok digest: entries with their verdict, source label, link in hex, and the usage', () => {
  const digest = assemble(input())
  assert.equal(digest.state, 'ok')
  assert.equal(digest.reason, undefined)
  const [first, second] = digest.entries
  assert.deepEqual(first, {
    key: 'personal:1',
    messageId: '<m1@x>',
    account: 'Gmail',
    from: 'Ana <ana@example.com>',
    subject: 'subject 1',
    date: '2026-10-06T07:00:00.000Z',
    link: 'https://mail.google.com/mail/u/cuenta%40gmail.com/#all/1999999999999999',
    category: 'action',
    priority: 'high',
    ask: 'reply',
    why: 'waiting',
    draft: 'Sí.',
    unsubscribeHeader: false,
    attachments: 0,
    seenLastTime: false,
  })
  assert.equal(second?.account, 'Macquarie')
  assert.deepEqual(digest.accounts, [{ id: 'personal', label: 'Gmail', state: 'ok', eligible: 2 }])
  assert.deepEqual(digest.window, { since: '2026-10-04T07:00:00.000Z', until: '2026-10-06T07:00:00.000Z' })
  assert.deepEqual(digest.usage, {
    batches: 1,
    failedBatches: 0,
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 0.01,
    ms: 30_000,
    model: 'claude-haiku-4-5-20251001',
  })
})

test('the Gmail link wants the id in hex; no id, no link', () => {
  assert.equal(gmailHex('255'), 'ff')
  assert.equal(gmailHex('1844674407370955161'), '1999999999999999')
  assert.equal(gmailHex(undefined), undefined)
  assert.equal(gmailHex('12ab'), undefined)
  const digest = assemble(input({ classified: [mail(1, { gmailId: undefined })] }))
  assert.equal(digest.entries[0]?.link, undefined)
})

test('a mail without a verdict is unclassified, and the run is still ok if its batch went well (criterion 12)', () => {
  const digest = assemble(input({ verdicts: new Map([[keyOf(mail(1)), { category: 'info', why: 'x' } as Verdict]]) }))
  assert.deepEqual(digest.entries.map((entry) => entry.category), ['info', 'unclassified'])
  assert.equal(digest.entries[1]?.why, undefined)
  assert.equal(digest.state, 'ok')
})

test('partial: one account failed and the other is there (criterion 9)', () => {
  const digest = assemble(input({ accounts: [{ account: PERSONAL, ok: true, mails: [mail(1), mail(2)] }, { account: OTHER, ok: false, reason: 'ENOTFOUND' }] }))
  assert.equal(digest.state, 'partial')
  assert.equal(digest.reason, '1 of 2 accounts failed')
  assert.deepEqual(digest.accounts[1], { id: 'other', label: 'Other', state: 'failed', reason: 'ENOTFOUND', eligible: 0 })
})

test('partial: a failed batch, or the cap expired with something classified (criterion 20)', () => {
  const failedBatch = assemble(input({ batches: { ...BATCHES, total: 2, failed: 1, firstReason: 'claude failed: 429' } }))
  assert.equal(failedBatch.state, 'partial')
  assert.equal(failedBatch.reason, '1 of 2 batches failed: claude failed: 429')
  const timedOut = assemble(input({ timedOut: 'timed out after 15 min' }))
  assert.equal(timedOut.state, 'partial')
  assert.equal(timedOut.reason, 'timed out after 15 min')
})

test('failed: every account failed, or mail and nothing classified (criteria 9, 20)', () => {
  const allFailed = assemble(input({ accounts: [{ account: PERSONAL, ok: false, reason: 'login refused' }], classified: [] }))
  assert.equal(allFailed.state, 'failed')
  assert.equal(allFailed.reason, '1 of 1 accounts failed')
  const nothing = assemble(input({ verdicts: new Map(), timedOut: 'timed out after 15 min' }))
  assert.equal(nothing.state, 'failed')
  assert.equal(nothing.reason, 'timed out after 15 min')
  const silent = assemble(input({ verdicts: new Map() }))
  assert.deepEqual([silent.state, silent.reason], ['failed', 'nothing was classified'])
})

test('an empty inbox is an ok digest with no entries', () => {
  const digest = assemble(input({ accounts: [{ account: PERSONAL, ok: true, mails: [] }], classified: [], verdicts: new Map(), batches: { ...BATCHES, total: 0 } }))
  assert.deepEqual([digest.state, digest.entries.length], ['ok', 0])
})

test('seenLastTime by Message-ID; without one, never (criterion 25)', () => {
  const previous = { entries: [{ messageId: '<m1@x>' }, { messageId: undefined }] } as unknown as Digest
  const mails = [mail(1), mail(2, { messageId: undefined }), mail(3)]
  const digest = assemble(input({ classified: mails, previous }))
  assert.deepEqual(digest.entries.map((entry) => entry.seenLastTime), [true, false, false])
})

test('overflow and effort are carried (criterion 16)', () => {
  const withEffort = parseInboxConfig({ effort: 'low', accounts: [{ ...PERSONAL, sources: [] }] })
  assert.equal(withEffort.ok, true)
  if (!withEffort.ok) return
  const digest = assemble(input({ overflow: 17, config: withEffort.config, batches: { ...BATCHES, model: undefined } }))
  assert.equal(digest.overflow, 17)
  assert.equal(digest.usage.effort, 'low')
  assert.equal(digest.usage.model, 'haiku')
})

test('an entry whose account is not configured any more keeps its id as label and no link', () => {
  const digest = assemble(input({ classified: [mail(1, { accountId: 'gone' })] }))
  assert.equal(digest.entries[0]?.account, 'gone')
  assert.equal(digest.entries[0]?.link, undefined)
})
