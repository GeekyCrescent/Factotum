/**
 * THE SENDER AGAINST A MADE-UP SERVER (spec 2026-11-12, M6; R38, R40, R41, R42, R44).
 *
 * The REAL nodemailer talks to `startFakeSmtp` over TLS verified against a CA made for this run.
 * Cutting the server at every step of the protocol IS the measurement of which `phase` each cut
 * gets: the raw nodemailer error at each one is written down here next to the phase it maps to.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeSmtp, type FakeSmtpServer, type SmtpCut } from './test-smtp-server.ts'
import { certificates, eventually, hasOpenssl, manualTimers, type ManualTimers } from './test-support.ts'
import { connectNodemailer, SEND_DEADLINE_MS, sendMail, SMTP_PORT, type ConnectSmtp, type SendInput, type SmtpOptions, type SmtpReply } from './smtp.ts'

const USER = 'owner.jobs@example.com'
const PASSWORD = 'abcdefghijklmnop'
const MESSAGE_ID = '<0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b@jobs.factotum.local>'
const CV = 'Juan-Rodrigo-Ferro-Rayon-CV.pdf'
const SRC = dirname(fileURLToPath(import.meta.url))

let tls: { ca: string; key: string; cert: string } | undefined
let pdf: { path: string; bytes: Buffer }

before(async () => {
  if (hasOpenssl()) tls = await certificates()
  const dir = await mkdtemp(join(tmpdir(), 'factotum-mail-cv-'))
  const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(3000)])
  const path = join(dir, 'cv.pdf')
  await writeFile(path, bytes)
  pdf = { path, bytes }
})

interface Harness {
  readonly server: FakeSmtpServer
  readonly clock: ManualTimers
  readonly connect: ConnectSmtp
  /** What sendMail handed the seam, and what nodemailer threw — raw, before the mapping. */
  readonly options: SmtpOptions[]
  readonly errors: unknown[]
}

const harnesses: Harness[] = []
after(async () => {
  for (const harness of harnesses) await harness.server.close()
})

async function harness(t: { skip: (message: string) => void }, cut?: SmtpCut): Promise<Harness | undefined> {
  if (tls === undefined) {
    t.skip('openssl is not installed: the sender test needs it to make a throwaway CA')
    return undefined
  }
  const ca = tls.ca
  const server = await startFakeSmtp(tls, { user: USER, password: PASSWORD, ...(cut === undefined ? {} : { cut }) })
  const options: SmtpOptions[] = []
  const errors: unknown[] = []
  const connect: ConnectSmtp = (given) => {
    options.push(given)
    // The double: loopback and this run's CA, verification ON. Never switched off (guardrail 6).
    const transport = connectNodemailer({
      ...given,
      host: '127.0.0.1',
      port: server.port,
      tls: { ...given.tls, ca, servername: 'localhost', rejectUnauthorized: true },
    })
    return {
      send: async (message, onBody) => {
        try {
          return await transport.send(message, onBody)
        } catch (error) {
          errors.push(error)
          throw error
        }
      },
      close: () => transport.close(),
    }
  }
  const built = { server, clock: manualTimers(), connect, options, errors }
  harnesses.push(built)
  return built
}

function input(clock: ManualTimers, extra: Partial<SendInput> = {}): SendInput {
  return {
    host: 'smtp.gmail.com',
    user: USER,
    password: PASSWORD,
    from: { name: 'Juan Rodrigo Ferro Rayón', address: USER },
    to: 'hiring@clinic.example',
    subject: 'Application — Data Analyst',
    text: 'Dear hiring team,\n\nPlease find my CV attached.\n\nJuan',
    messageId: MESSAGE_ID,
    attachment: { filename: CV, path: pdf.path },
    timers: clock.timers,
    signal: new AbortController().signal,
    ...extra,
  }
}

/** The shape of a nodemailer error the test compares, nothing else (no message: it may echo the server). */
function shapeOf(error: unknown): { code: unknown; command: unknown; responseCode: unknown } {
  const record = error as { code?: unknown; command?: unknown; responseCode?: unknown }
  return { code: record.code, command: record.command, responseCode: record.responseCode }
}

/** The attachment part's body, decoded. */
function attachmentIn(message: string): Buffer {
  const at = message.indexOf(`filename=${CV}`)
  assert.notEqual(at, -1, 'the attachment is named')
  const start = message.indexOf('\r\n\r\n', at) + 4
  const end = message.indexOf('\r\n--', start)
  return Buffer.from(message.slice(start, end).replace(/\r\n/g, ''), 'base64')
}

test('a message goes out: AUTH PLAIN, the envelope, our Message-ID, plain text and the CV in base64', async (t) => {
  const h = await harness(t)
  if (h === undefined) return

  const result = await sendMail(input(h.clock), h.connect)

  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) return
  assert.equal(result.messageId, MESSAGE_ID)
  assert.match(result.response, /^250 2\.0\.0 OK /)
  assert.deepEqual(h.server.commands.slice(0, 5), ['EHLO', 'AUTH PLAIN', `MAIL FROM:<${USER}>`, 'RCPT TO:<hiring@clinic.example>', 'DATA'])
  assert.equal(h.server.messages.length, 1)
  const message = h.server.messages[0] ?? ''
  assert.match(message, new RegExp(`^Message-ID: ${MESSAGE_ID}\r$`, 'mi'))
  assert.match(message, /^Subject: /m)
  assert.match(message, /^Content-Type: text\/plain/m)
  assert.equal(/text\/html/i.test(message), false, 'no HTML part')
  assert.match(message, /Content-Transfer-Encoding: base64/)
  assert.deepEqual(attachmentIn(message), pdf.bytes)
  assert.equal(/^In-Reply-To:/im.test(message), false)
  assert.deepEqual(h.clock.pending(), [], 'the deadline is disposed once the send is over')
})

test('a reply carries In-Reply-To and References', async (t) => {
  const h = await harness(t)
  if (h === undefined) return
  const original = '<0193a1b2-0000-7000-8000-000000000001@jobs.factotum.local>'
  const theirs = '<CAF=reply-1@mail.gmail.com>'

  const result = await sendMail(input(h.clock, { inReplyTo: theirs, references: [original, theirs] }), h.connect)

  assert.equal(result.ok, true, JSON.stringify(result))
  // A long header may be folded (RFC 5322 §2.2.3): unfold before reading it.
  const message = (h.server.messages[0] ?? '').replace(/\r\n[ \t]+/g, ' ')
  assert.match(message, new RegExp(`^In-Reply-To: ${theirs}\r$`, 'mi'))
  assert.match(message, new RegExp(`^References: ${original} ${theirs}\r$`, 'mi'))
})

test('the options: implicit TLS on 465, 10/10/20 s, TLS 1.2 or later, no logger, verification never off', async (t) => {
  const h = await harness(t)
  if (h === undefined) return

  await sendMail(input(h.clock), h.connect)

  const [options] = h.options
  assert.equal(options?.host, 'smtp.gmail.com')
  assert.equal(options?.port, SMTP_PORT)
  assert.equal(SMTP_PORT, 465)
  assert.equal(options?.secure, true)
  assert.deepEqual(options?.auth, { user: USER, pass: PASSWORD })
  assert.equal(options?.logger, false)
  assert.equal(options?.debug, false)
  assert.equal(options?.connectionTimeout, 10_000)
  assert.equal(options?.greetingTimeout, 10_000)
  assert.equal(options?.socketTimeout, 20_000)
  assert.deepEqual(options?.tls, { minVersion: 'TLSv1.2', autoSelectFamilyAttemptTimeout: 2_500 })
})

/**
 * THE MEASUREMENT (M6). Each row: where the server cuts, what nodemailer 10.5.0 throws, the phase.
 * A dropped socket is `ECONNECTION`/`CONN` at EVERY step, so `command` cannot tell a cut before the
 * body from one after it: the phase comes from the sender's own "the body started" flag. A refusal
 * (a 4xx/5xx reply) is the server saying it did NOT take the message: `before-data` wherever it comes.
 */
const CUTS: readonly {
  readonly cut: SmtpCut
  readonly raw: { code: string; command: string; responseCode: number | undefined }
  readonly phase: 'before-data' | 'after-data'
}[] = [
  { cut: { at: 'greeting', how: 'close' }, raw: { code: 'ECONNECTION', command: 'CONN', responseCode: undefined }, phase: 'before-data' },
  { cut: { at: 'EHLO', how: 'close' }, raw: { code: 'ECONNECTION', command: 'CONN', responseCode: undefined }, phase: 'before-data' },
  { cut: { at: 'AUTH', how: 'close' }, raw: { code: 'ECONNECTION', command: 'CONN', responseCode: undefined }, phase: 'before-data' },
  { cut: { at: 'MAIL FROM', how: 'close' }, raw: { code: 'ECONNECTION', command: 'CONN', responseCode: undefined }, phase: 'before-data' },
  { cut: { at: 'RCPT TO', how: 'close' }, raw: { code: 'ECONNECTION', command: 'CONN', responseCode: undefined }, phase: 'before-data' },
  { cut: { at: 'DATA', how: 'close' }, raw: { code: 'ECONNECTION', command: 'CONN', responseCode: undefined }, phase: 'before-data' },
  { cut: { at: 'message', how: 'close' }, raw: { code: 'ECONNECTION', command: 'CONN', responseCode: undefined }, phase: 'after-data' },
  { cut: { at: 'MAIL FROM', how: '550 5.7.1 Sender refused - gsmtp' }, raw: { code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 550 }, phase: 'before-data' },
  { cut: { at: 'RCPT TO', how: '550 5.1.1 No such user - gsmtp' }, raw: { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 }, phase: 'before-data' },
  { cut: { at: 'DATA', how: '554 5.5.1 Error: no valid recipients' }, raw: { code: 'EENVELOPE', command: 'DATA', responseCode: 554 }, phase: 'before-data' },
  { cut: { at: 'message', how: '552 5.3.4 Your message exceeded the size limit - gsmtp' }, raw: { code: 'EMESSAGE', command: 'DATA', responseCode: 552 }, phase: 'before-data' },
  { cut: { at: 'message', how: '451 4.3.0 Mail server temporarily rejected message - gsmtp' }, raw: { code: 'EMESSAGE', command: 'DATA', responseCode: 451 }, phase: 'before-data' },
]

for (const { cut, raw, phase } of CUTS) {
  test(`a cut at ${cut.at} (${cut.how.split(' ')[0] ?? ''}) is ${raw.code}/${raw.command} and ${phase}`, async (t) => {
    const h = await harness(t, cut)
    if (h === undefined) return

    const result = await sendMail(input(h.clock), h.connect)

    assert.deepEqual(h.errors.map(shapeOf), [raw])
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.phase, phase)
    assert.notEqual(result.reason, '')
    assert.deepEqual(h.clock.pending(), [])
  })
}

test('a wrong password is the shape A1(d) measured on Gmail: EAUTH, AUTH PLAIN, 535 — before-data', async (t) => {
  const h = await harness(t)
  if (h === undefined) return

  const result = await sendMail(input(h.clock, { password: 'wrong-password-x' }), h.connect)

  assert.deepEqual(h.errors.map(shapeOf), [{ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 }])
  const message = (h.errors[0] as Error).message
  assert.match(message, /^Invalid login: 535-5\.7\.8 Username and Password not accepted\./)
  assert.match(message, /BadCredentials .* - gsmtp$/)
  assert.deepEqual(h.server.commands, ['EHLO', 'AUTH PLAIN'])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.phase, 'before-data')
  assert.match(result.reason, /^535/)
})

test('a server that goes silent after the body ends at SEND_DEADLINE_MS, after-data', async (t) => {
  const h = await harness(t, { at: 'message', how: 'silent' })
  if (h === undefined) return

  const sending = sendMail(input(h.clock), h.connect)
  await eventually(() => h.server.messages.length === 1)
  assert.equal(SEND_DEADLINE_MS, 40_000)
  assert.deepEqual(h.clock.pending(), [SEND_DEADLINE_MS])
  h.clock.fire(SEND_DEADLINE_MS)
  const result = await sending

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.phase, 'after-data')
  assert.match(result.reason, /no answer within 40 s/)
})

test('a server that goes silent at MAIL FROM ends at the deadline too, before-data', async (t) => {
  const h = await harness(t, { at: 'MAIL FROM', how: 'silent' })
  if (h === undefined) return

  const sending = sendMail(input(h.clock), h.connect)
  // Once silent the fake reads nothing more: what it last wrote down is the step it stopped at.
  await eventually(() => h.server.commands.includes(`MAIL FROM:<${USER}>`))
  h.clock.fire(SEND_DEADLINE_MS)
  const result = await sending

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.phase, 'before-data')
  assert.match(result.reason, /no answer within 40 s/)
  assert.equal(h.server.messages.length, 0)
})

test('the caller aborting (stop) ends the send at once, reason "stopped"', async (t) => {
  const h = await harness(t, { at: 'RCPT TO', how: 'silent' })
  if (h === undefined) return
  const stop = new AbortController()

  const sending = sendMail(input(h.clock, { signal: stop.signal }), h.connect)
  await eventually(() => h.server.commands.includes('RCPT TO:<hiring@clinic.example>'))
  stop.abort()
  const result = await sending

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'stopped')
  assert.equal(result.phase, 'before-data')
  assert.deepEqual(h.clock.pending(), [])
})

test('an already aborted signal never connects', async (t) => {
  const h = await harness(t)
  if (h === undefined) return

  const result = await sendMail(input(h.clock, { signal: AbortSignal.abort() }), h.connect)

  assert.deepEqual(result, { ok: false, phase: 'before-data', reason: 'stopped' })
  assert.deepEqual(h.options, [])
})

test('the reason never carries the user or the password', async (t) => {
  const h = await harness(t, { at: 'MAIL FROM', how: `550 5.7.1 ${USER} may not send; key ${PASSWORD} revoked - gsmtp` })
  if (h === undefined) return

  const result = await sendMail(input(h.clock), h.connect)

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason.includes(USER), false)
  assert.equal(result.reason.includes(PASSWORD), false)
  assert.match(result.reason, /<user> may not send; key \*\*\* revoked/)
})

test('a 250 that is not Gmail\'s "250 2.0.0 OK" is not taken as sent: after-data', async (t) => {
  const h = await harness(t, { at: 'message', how: '250 Queued' })
  if (h === undefined) return

  const result = await sendMail(input(h.clock), h.connect)

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.phase, 'after-data')
  assert.equal(result.reason, 'unexpected answer: 250 Queued')
})

test('an attachment that cannot be read never finishes a body: before-data, and nothing crashes', async (t) => {
  const h = await harness(t)
  if (h === undefined) return

  const result = await sendMail(input(h.clock, { attachment: { filename: CV, path: join(tmpdir(), 'factotum-mail-no-such-cv.pdf') } }), h.connect)

  assert.deepEqual(h.errors.map(shapeOf), [{ code: 'ESTREAM', command: 'API', responseCode: undefined }])
  assert.equal(h.server.messages.length, 0)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.phase, 'before-data')
  assert.match(result.reason, /ENOENT|ESTREAM/)
})

test('the caller aborting (stop) after the body went out is after-data: the server may have it', async (t) => {
  const h = await harness(t, { at: 'message', how: 'silent' })
  if (h === undefined) return
  const stop = new AbortController()

  const sending = sendMail(input(h.clock, { signal: stop.signal }), h.connect)
  await eventually(() => h.server.messages.length === 1)
  stop.abort()
  const result = await sending

  assert.deepEqual(result, { ok: false, phase: 'after-data', reason: 'stopped' })
  assert.deepEqual(h.clock.pending(), [])
})

/** A seam that records what it is asked, for the steps that must happen before (or without) a connection. */
function fakeConnect(behaviour: { readonly throwOnConnect?: Error; readonly reply?: SmtpReply }): { readonly connect: ConnectSmtp; readonly calls: string[] } {
  const calls: string[] = []
  const connect: ConnectSmtp = () => {
    calls.push('connect')
    if (behaviour.throwOnConnect !== undefined) throw behaviour.throwOnConnect
    return {
      send: (payload, onBody) => {
        calls.push(`send ${payload.envelope.to.join(',')}`)
        onBody()
        return Promise.resolve(behaviour.reply ?? { response: '250 2.0.0 OK  1 x - gsmtp', rejected: [] })
      },
      close: () => calls.push('close'),
    }
  }
  return { connect, calls }
}

test('a connect that throws at once is before-data, never a throw, and leaves no timer armed', async () => {
  const clock = manualTimers()
  const { connect } = fakeConnect({ throwOnConnect: new Error(`bad socket for ${USER}`) })

  const result = await sendMail(input(clock), connect)

  assert.deepEqual(result, { ok: false, phase: 'before-data', reason: 'bad socket for <user>' })
  assert.deepEqual(clock.pending(), [])
})

test('a message that cannot be composed is before-data and never connects', async () => {
  const clock = manualTimers()
  const { connect, calls } = fakeConnect({})

  const result = await sendMail(input(clock, { references: 7 as unknown as readonly string[] }), connect)

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.phase, 'before-data')
  assert.match(result.reason, /^the message could not be composed: /)
  assert.deepEqual(calls, [])
  assert.deepEqual(clock.pending(), [])
})

test('a recipient that is not exactly one address, or carries CR/LF, is invalid-recipient before connecting', async () => {
  for (const to of [
    'hiring@clinic.example\r\nBcc: other@evil.example',
    'a@clinic.example, b@clinic.example',
    'not an address',
    '',
    'hiring@clinic.example\n',
    // A display name that is itself an address: the To: header would show one, the envelope use another.
    '"boss@a.com" <x@b.com>',
    'boss@a.com <x@b.com>',
    'Hiring Team <hiring@clinic.example>',
  ]) {
    const clock = manualTimers()
    const { connect, calls } = fakeConnect({})

    const result = await sendMail(input(clock, { to }), connect)

    assert.deepEqual(result, { ok: false, phase: 'before-data', reason: 'invalid-recipient' }, JSON.stringify(to))
    assert.deepEqual(calls, [], JSON.stringify(to))
  }
  const { connect, calls } = fakeConnect({})
  assert.equal((await sendMail(input(manualTimers(), { to: ' hiring@clinic.example ' }), connect)).ok, true)
  assert.deepEqual(calls.filter((c) => c.startsWith('send')), ['send hiring@clinic.example'])
})

test('a 250 with the recipient in info.rejected is not sent: before-data, the server said it did not take it', async () => {
  const { connect } = fakeConnect({ reply: { response: '250 2.0.0 OK  1 x - gsmtp', rejected: ['hiring@clinic.example'] } })

  const result = await sendMail(input(manualTimers()), connect)

  assert.deepEqual(result, { ok: false, phase: 'before-data', reason: 'the server rejected the recipient' })
})

test('no file in this package switches certificate verification off', async () => {
  const offenders: string[] = []
  for (const name of await readdir(SRC, { recursive: true })) {
    if (!name.endsWith('.ts')) continue
    const source = await readFile(join(SRC, name), 'utf8')
    if (/rejectUnauthorized\s*:\s*false/.test(source)) offenders.push(name)
  }
  assert.deepEqual(offenders, [])
})
