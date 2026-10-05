import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AccountConfig } from '../config.ts'
import { imapDouble, type FakeMail } from '../test-imap-client.ts'
import { eventually, manualTimers } from '../test-support.ts'
import { ACCOUNT_TIMEOUT_MS, fetchAccount, MAX_PART_BYTES, type FetchInput } from './fetch.ts'

const NOW = new Date('2026-10-06T08:00:00.000Z')
const SINCE = new Date(NOW.getTime() - 48 * 3600_000)
const HOUR = 3600_000
const PASSWORD = 'abcdefghijklmnop'

const ACCOUNT: AccountConfig = {
  id: 'personal',
  label: 'Gmail',
  host: 'imap.gmail.com',
  user: 'cuenta@gmail.com',
  passwordFile: '/secret',
  read: 'unread',
  sources: [{ id: 'mq', label: 'Macquarie', address: 'me@students.mq.edu.au', read: 'all' }],
}

function mail(uid: number, hoursAgo: number, extra: Partial<FakeMail> = {}): FakeMail {
  return {
    uid,
    internalDate: new Date(NOW.getTime() - hoursAgo * HOUR),
    from: { name: 'Ana', address: 'ana@example.com' },
    subject: `subject ${uid}`,
    messageId: `<m${uid}@example.com>`,
    parts: { '1': `body of ${uid}` },
    ...extra,
  }
}

function input(connect: FetchInput['connect'], over: Partial<FetchInput> = {}): FetchInput {
  return {
    account: ACCOUNT,
    password: PASSWORD,
    since: SINCE,
    signal: new AbortController().signal,
    connect,
    timers: manualTimers().timers,
    maxBodies: 400,
    ...over,
  }
}

test('the window and the read rule per source: unread for the account, all for a forwarded source (criterion 4)', async () => {
  const double = imapDouble([
    mail(1, 1),
    mail(2, 2, { seen: true }),
    mail(3, 3, { seen: true, headers: 'Resent-From: me@students.mq.edu.au\r\n' }),
    mail(4, 49),
    mail(5, 60, { seen: false }),
  ])
  const result = await fetchAccount(input(double.connect))
  assert.equal(result.ok, true)
  if (!result.ok) return
  // 1: unread, in. 2: read, the account's rule leaves it out. 3: read, but its source reads all.
  // 4 and 5: SINCE took them (the day before), the window in memory leaves them out.
  assert.deepEqual(result.mails.map((m) => m.uid), [1, 3])
  assert.deepEqual(result.mails.map((m) => m.sourceId), [undefined, 'mq'])
  const first = result.mails[0]!
  assert.equal(first.body, 'body of 1')
  assert.equal(first.from, 'Ana <ana@example.com>')
  assert.equal(first.subject, 'subject 1')
  assert.equal(first.messageId, '<m1@example.com>')
  assert.equal(first.date, new Date(NOW.getTime() - HOUR).toISOString())
})

test('built with logger false, the four disable* and the three timeouts, on 993 with TLS', async () => {
  const double = imapDouble([])
  await fetchAccount(input(double.connect))
  assert.deepEqual(double.built, [
    {
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: 'cuenta@gmail.com', pass: PASSWORD },
      logger: false,
      disableAutoIdle: true,
      disableCompression: true,
      disableBinary: true,
      disableAutoEnable: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    },
  ])
})

test('INBOX opened read-only; search and both fetches by UID; bodies capped, one fetch per part (guardrail 1, 9)', async () => {
  const nested = { type: 'multipart/alternative', childNodes: [{ part: '1.1', type: 'text/plain' }, { part: '1.2', type: 'text/html' }] }
  const double = imapDouble([
    mail(7, 1, { headers: 'List-Unsubscribe: <mailto:u@x.com>\r\n' }),
    mail(9, 2),
    mail(11, 3, { structure: nested, parts: { '1.1': 'nested body' } }),
  ])
  const result = await fetchAccount(input(double.connect))
  assert.equal(result.ok, true)
  const byMethod = (method: string) => double.calls.filter((call) => call.method === method)
  assert.deepEqual(byMethod('mailboxOpen').map((call) => call.args), [['INBOX', { readOnly: true }]])
  const [search] = byMethod('search')
  assert.deepEqual(search!.args[1], { uid: true })
  assert.equal((search!.args[0] as { since: Date }).since.getTime(), SINCE.getTime() - 24 * HOUR)
  const [fetch, ...bodies] = byMethod('fetchAll')
  assert.equal(fetch!.args[0], '7,9,11')
  assert.deepEqual(fetch!.args[2], { uid: true })
  assert.deepEqual((fetch!.args[1] as { headers: string[] }).headers, ['list-unsubscribe', 'resent-from', 'x-forwarded-for', 'delivered-to'])
  assert.deepEqual(bodies.map((call) => call.args), [
    ['7,9', { bodyParts: [{ key: '1', maxLength: MAX_PART_BYTES }] }, { uid: true }],
    ['11', { bodyParts: [{ key: '1.1', maxLength: MAX_PART_BYTES }] }, { uid: true }],
  ])
  assert.deepEqual(result.ok && result.mails.map((m) => m.body), ['body of 7', 'body of 9', 'nested body'])
  assert.equal(byMethod('logout').length, 1)
  assert.equal(result.ok && result.mails[0]!.unsubscribe, true)
  assert.equal(result.ok && result.mails[1]!.unsubscribe, false)
})

test('an empty window is an empty list, and nothing is fetched', async () => {
  const double = imapDouble([mail(1, 100)])
  const result = await fetchAccount(input(double.connect))
  assert.deepEqual(result, { ok: true, mails: [] })
  assert.equal(double.calls.some((call) => call.method === 'fetchAll'), false)
})

test('bodies only for the newest maxBodies; a part that is not there is an empty body', async () => {
  const double = imapDouble([mail(1, 3), mail(2, 1), mail(3, 2, { parts: {} })])
  const result = await fetchAccount(input(double.connect, { maxBodies: 2 }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.mails.map((m) => [m.uid, m.body]), [[2, 'body of 2'], [3, ''], [1, '']])
  const bodyFetches = double.calls.filter((call) => call.method === 'fetchAll').slice(1)
  assert.deepEqual(bodyFetches.map((call) => call.args[0]), ['2,3'])
})

test('a refused login is ok:false with the server words, never the password (criterion 9)', async () => {
  const double = imapDouble([], { refuseLogin: { response: `[AUTHENTICATIONFAILED] Invalid credentials for cuenta@gmail.com ${PASSWORD}` } })
  const result = await fetchAccount(input(double.connect))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'login refused: [AUTHENTICATIONFAILED] Invalid credentials for <user> ***')
  assert.equal(result.reason.includes(PASSWORD), false)
})

test('no network is ok:false with Node’s code', async () => {
  const result = await fetchAccount(input(imapDouble([], { networkError: 'ENOTFOUND' }).connect))
  assert.deepEqual(result, { ok: false, reason: 'ENOTFOUND' })
})

test('an account that does not answer is cut at its own cap, with the kernel’s timers (criterion 9)', async () => {
  const manual = manualTimers()
  const double = imapDouble([mail(1, 1)], { stall: 'search' })
  const pending = fetchAccount(input(double.connect, { timers: manual.timers }))
  await eventually(() => double.calls.some((call) => call.method === 'search'), 'the search was sent')
  assert.deepEqual(manual.pending(), [ACCOUNT_TIMEOUT_MS])
  manual.fire(ACCOUNT_TIMEOUT_MS)
  assert.deepEqual(await pending, { ok: false, reason: 'no answer within 90 s' })
  assert.equal(double.closed(), 1)
  assert.equal(double.calls.some((call) => call.method === 'logout'), false)
  assert.deepEqual(manual.pending(), [])
})

test('the run’s signal aborted mid-account closes the connection', async () => {
  const run = new AbortController()
  const double = imapDouble([mail(1, 1)], { stall: 'bodies', settleOnClose: true })
  const pending = fetchAccount(input(double.connect, { signal: run.signal }))
  await eventually(() => double.calls.filter((call) => call.method === 'fetchAll').length === 2, 'the bodies were asked')
  run.abort()
  assert.deepEqual(await pending, { ok: false, reason: 'stopped' })
  assert.equal(double.closed() >= 1, true)
})

test('a signal already aborted never connects', async () => {
  const run = new AbortController()
  run.abort()
  const double = imapDouble([mail(1, 1)])
  assert.deepEqual(await fetchAccount(input(double.connect, { signal: run.signal })), { ok: false, reason: 'stopped' })
  assert.deepEqual(double.built, [])
})

test('a body in quoted-printable and latin-1 arrives decoded', async () => {
  const structure = { type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'iso-8859-1' } }
  const double = imapDouble([mail(1, 1, { structure, parts: { '1': 'Se=F1or, ma=F1ana a las 9.' } })])
  const result = await fetchAccount(input(double.connect))
  assert.deepEqual(result.ok && result.mails.map((m) => m.body), ['Señor, mañana a las 9.'])
})

test('a server that never answers LOGOUT holds the account 5 s at most, then the socket is dropped', async () => {
  const manual = manualTimers()
  const double = imapDouble([mail(1, 1)], { stall: 'logout' })
  const pending = fetchAccount(input(double.connect, { timers: manual.timers }))
  await eventually(() => double.calls.some((call) => call.method === 'logout'), 'logout was sent')
  assert.deepEqual(manual.pending(), [5_000])
  manual.fire(5_000)
  const result = await pending
  assert.deepEqual(result.ok && result.mails.map((m) => m.uid), [1])
  assert.equal(double.closed(), 1)
})

test('a hostile subject and display name are cut, so they cannot grow the prompt or the digest', async () => {
  const double = imapDouble([mail(1, 1, { subject: 'S'.repeat(10_000), from: { name: 'N'.repeat(10_000), address: 'a@b.c' } })])
  const result = await fetchAccount(input(double.connect))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.mails[0]!.subject.length, 300)
  assert.equal(result.mails[0]!.from.length, 200)
  assert.equal(result.mails[0]!.subject.endsWith('…'), true)
})
