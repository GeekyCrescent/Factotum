/**
 * The pieces of one IMAP session (spec 2026-11-12, M3b; R71): the options measured against Gmail,
 * the wait that ends with the signal, the bounded LOGOUT on a made-up clock, and a reason that never
 * carries a secret.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imapDouble } from '../testing.ts'
import { manualTimers } from '../test-support.ts'
import type { ImapClient } from './client.ts'
import { closeQuietly, IMAP_PORT, imapOptions, mask, reasonOf, untilAborted } from './session.ts'

/** `session.ts` keeps both private; the numbers are the contract these tests hold it to. */
const LOGOUT_MAX_MS = 5_000
const REASON_MAX = 200

const USER = 'cuenta@gmail.com'
const PASSWORD = 'abcdefghijklmnop'
const SECRETS = { user: USER, password: PASSWORD }

/** A tick of the microtask queue and the next macrotask, so settled promises have run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('imapOptions: TLS on IMAP_PORT (993), the account’s login, and no logger', () => {
  const options = imapOptions({ host: 'imap.gmail.com', user: USER }, PASSWORD)

  assert.equal(IMAP_PORT, 993)
  assert.equal(options.host, 'imap.gmail.com')
  assert.equal(options.port, IMAP_PORT)
  assert.equal(options.secure, true)
  assert.deepEqual(options.auth, { user: USER, pass: PASSWORD })
  assert.equal(options.logger, false)
})

test('imapOptions: Happy Eyeballs gets 2.5 s per address, and nothing else in tls (verification stays on)', () => {
  const options = imapOptions({ host: 'imap.gmail.com', user: USER }, PASSWORD)

  assert.deepEqual(options.tls, { autoSelectFamilyAttemptTimeout: 2_500 })
})

test('imapOptions: the measured switches and timeouts, nothing else', () => {
  const options = imapOptions({ host: 'imap.gmail.com', user: USER }, PASSWORD)

  assert.equal(options.disableAutoIdle, true)
  assert.equal(options.disableCompression, true)
  assert.equal(options.disableBinary, true)
  assert.equal(options.disableAutoEnable, true)
  assert.equal(options.connectionTimeout, 15_000)
  assert.equal(options.greetingTimeout, 15_000)
  assert.equal(options.socketTimeout, 60_000)
})

test('reasonOf prefers the server’s response, then Node’s code, then the message', () => {
  assert.equal(reasonOf({ response: 'NO busy', code: 'ECONNRESET', message: 'm' }, SECRETS), 'NO busy')
  assert.equal(reasonOf({ response: '', code: 'ECONNRESET', message: 'm' }, SECRETS), 'ECONNRESET')
  assert.equal(reasonOf(new Error('socket hang up'), SECRETS), 'socket hang up')
})

test('reasonOf says "unknown error" for something with no words, or nothing at all', () => {
  assert.equal(reasonOf({ code: 42 }, SECRETS), 'unknown error')
  assert.equal(reasonOf(undefined, SECRETS), 'unknown error')
  assert.equal(reasonOf(null, SECRETS), 'unknown error')
})

test('reasonOf prefixes a refused login', () => {
  const error = { authenticationFailed: true, response: 'NO [AUTHENTICATIONFAILED] Invalid credentials' }

  assert.equal(reasonOf(error, SECRETS), 'login refused: NO [AUTHENTICATIONFAILED] Invalid credentials')
})

test('reasonOf never returns the password or the user', () => {
  const error = { response: `NO ${USER} said ${PASSWORD}, then ${PASSWORD} again` }

  const reason = reasonOf(error, SECRETS)

  assert.equal(reason, 'NO <user> said ***, then *** again')
  assert.equal(reason.includes(PASSWORD), false)
  assert.equal(reason.includes(USER), false)
})

test('reasonOf masks the recipient whatever its case, and leaves the text alone when there is none', () => {
  const error = { response: '550 No such user: Ana.Garcia@Example.COM' }

  assert.equal(reasonOf(error, { ...SECRETS, recipient: ' ana.garcia@example.com ' }), '550 No such user: <recipient>')
  assert.equal(reasonOf(error, SECRETS), '550 No such user: Ana.Garcia@Example.COM')
  assert.equal(reasonOf(error, { ...SECRETS, recipient: '' }), '550 No such user: Ana.Garcia@Example.COM')
})

test('reasonOf cuts at REASON_MAX, prefix included', () => {
  const reason = reasonOf({ authenticationFailed: true, response: 'x'.repeat(500) }, SECRETS)

  assert.equal(reason.length, REASON_MAX)
  assert.ok(reason.startsWith('login refused: x'))
})

test('reasonOf masks before it cuts: a secret across the cut leaves no prefix of itself', () => {
  const words = `${'x'.repeat(REASON_MAX - 4)}${PASSWORD}`

  const reason = reasonOf({ response: words }, SECRETS)

  assert.equal(reason.includes(PASSWORD.slice(0, 4)), false)
})

test('mask replaces every occurrence, and an empty secret masks nothing', () => {
  assert.equal(mask('a-s-a-s', 's', '*'), 'a-*-a-*')
  assert.equal(mask('abc', '', '*'), 'abc')
})

test('untilAborted gives the work’s value, or its error, when the signal never fires', async () => {
  const signal = new AbortController().signal

  assert.equal(await untilAborted(Promise.resolve(7), signal), 7)
  await assert.rejects(untilAborted(Promise.reject(new Error('NO')), signal), /NO/)
})

test('untilAborted settles at the abort, with its reason, while the work never does', async () => {
  const controller = new AbortController()
  const waiting = untilAborted(new Promise<never>(() => undefined), controller.signal)

  controller.abort(new Error('stopped'))

  await assert.rejects(waiting, /stopped/)
})

test('untilAborted on an aborted signal rejects at once, and swallows the work’s later rejection', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cap'))
  let fail: (error: Error) => void = () => undefined
  const work = new Promise<never>((_resolve, reject) => {
    fail = reject
  })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)

  await assert.rejects(untilAborted(work, controller.signal), /cap/)
  fail(new Error('late'))
  await settle()

  process.off('unhandledRejection', onUnhandled)
  assert.deepEqual(unhandled, [])
})

test('untilAborted lets go of the signal once the work settles', async () => {
  const controller = new AbortController()

  await untilAborted(Promise.resolve('done'), controller.signal)
  controller.abort(new Error('after'))
  await settle()
  // No listener left to reject a settled promise; reaching here without an unhandled rejection is the point.
  assert.equal(controller.signal.aborted, true)
})

test('closeQuietly with no client, or after an abort, touches nothing', async () => {
  const double = imapDouble([])
  const client = double.connect(imapOptions({ host: 'h', user: USER }, PASSWORD))
  const clock = manualTimers()

  await closeQuietly(undefined, false, clock.timers)
  await closeQuietly(client, true, clock.timers)

  assert.deepEqual(double.calls, [])
  assert.deepEqual(clock.pending(), [])
})

test('closeQuietly says LOGOUT, then closes, and leaves no timer armed', async () => {
  const double = imapDouble([])
  const client = double.connect(imapOptions({ host: 'h', user: USER }, PASSWORD))
  const clock = manualTimers()

  await closeQuietly(client, false, clock.timers)

  assert.deepEqual(double.calls.map((call) => call.method), ['logout', 'close'])
  assert.deepEqual(clock.pending(), [])
})

test('closeQuietly does not throw when logout fails, nor when close does', async () => {
  const client: ImapClient = {
    ...imapDouble([]).connect(imapOptions({ host: 'h', user: USER }, PASSWORD)),
    logout: () => Promise.reject(new Error('Connection not available')),
    close: () => {
      throw new Error('already closed')
    },
  }

  await closeQuietly(client, false, manualTimers().timers)
})

test('closeQuietly does not wait past LOGOUT_MAX_MS for a server that never answers LOGOUT', async () => {
  const double = imapDouble([], { stall: 'logout' })
  const client = double.connect(imapOptions({ host: 'h', user: USER }, PASSWORD))
  const clock = manualTimers()
  let done = false

  const closing = closeQuietly(client, false, clock.timers).then(() => {
    done = true
  })
  await settle()
  assert.equal(done, false)
  assert.deepEqual(clock.pending(), [LOGOUT_MAX_MS])

  assert.equal(clock.fire(LOGOUT_MAX_MS), 1)
  await closing

  assert.equal(done, true)
  assert.equal(double.closed(), 1)
  assert.deepEqual(clock.pending(), [])
})
