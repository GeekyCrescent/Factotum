/**
 * The sender (spec 2026-11-12, D4): ONE message, over implicit TLS on 465, behind a seam.
 *
 * NOTHING THROWS OUT OF HERE. Every way it can go wrong ends in `{ ok: false, phase, reason }`, and
 * the reason goes through the same mask as `reasonOf`: never the password, the user name and the
 * recipient masked.
 *
 * THE PHASE IS WHAT THE CALLER NEEDS TO KNOW: `before-data` means the server cannot have the message
 * (retrying is safe), `after-data` that it may (it must not be sent again blindly). Measured in M6
 * against the fake server: nodemailer reports a dropped socket or a timeout as `command: 'CONN'` at
 * EVERY step, and with PIPELINING it writes `DATA` together with the envelope — so neither its
 * `command` nor "DATA was written" can tell the two apart. What does: the body is a lazy stream that
 * nodemailer only reads after the server answered `354`, and reading it flips `bodyStarted`.
 * A 4xx/5xx reply anywhere is the server refusing the message, and a body that failed to read was
 * never finished: both are `before-data` wherever they come. So is a recipient in `info.rejected`.
 *
 * WHAT CAN FAIL WITHOUT A SERVER FAILS FIRST: the `to` must be exactly one address with no CR/LF
 * (`invalid-recipient`), and the MIME tree is composed before connecting — both `before-data`.
 *
 * EACH ATTEMPT ENDS WITHIN SEND_DEADLINE_MS, on the injected timers, well under the proxy's 60 s.
 */

import type { TcpNetConnectOpts } from 'node:net'
import { Readable } from 'node:stream'
import type { ConnectionOptions } from 'node:tls'
import type { Timers } from '@factotum/core'
import addressparser from 'nodemailer/lib/addressparser'
import MailComposer from 'nodemailer/lib/mail-composer'
import SMTPConnection from 'nodemailer/lib/smtp-connection'
import { reasonOf, untilAborted } from './imap/session.ts'

/** Implicit TLS, and nothing else: no STARTTLS to strip (guardrail 6). */
export const SMTP_PORT = 465
/** Per attempt, everything included (D4): far below PROXY_POST_TIMEOUT_MS (60 s). */
export const SEND_DEADLINE_MS = 40_000

/** A1(b): `250 2.0.0 OK  <epoch> <id> - gsmtp`. The rest varies, so only the start is compared. */
const ACCEPTED = '250 2.0.0 OK'
const STOPPED = 'stopped'

export interface SendInput {
  /** smtp.gmail.com. The port is SMTP_PORT, always. */
  readonly host: string
  readonly user: string
  readonly password: string
  readonly from: { readonly name: string; readonly address: string }
  readonly to: string
  readonly subject: string
  readonly text: string
  /** Set by the caller (`<uuidv7@jobs.factotum.local>`), and kept by Gmail (A1). */
  readonly messageId: string
  readonly inReplyTo?: string
  readonly references?: readonly string[]
  readonly attachment?: { readonly filename: string; readonly path: string }
  readonly timers: Timers
  /** The caller's: `stop()`. */
  readonly signal: AbortSignal
}

export type SendResult =
  | { readonly ok: true; readonly messageId: string; readonly response: string }
  | { readonly ok: false; readonly phase: 'before-data' | 'after-data'; readonly reason: string }

export type SmtpMessage = Pick<SendInput, 'from' | 'to' | 'subject' | 'text' | 'messageId' | 'inReplyTo' | 'references' | 'attachment'>

/** What a transport is built with. `tls` may carry a test CA; certificate checks are never switched off (guardrail 6). */
export interface SmtpOptions {
  readonly host: string
  readonly port: number
  readonly secure: true
  readonly auth: { readonly user: string; readonly pass: string }
  readonly logger: false
  readonly debug: false
  readonly connectionTimeout: number
  readonly greetingTimeout: number
  readonly socketTimeout: number
  /** Handed to `tls.connect()`, which passes the socket half on to `net` (see ImapOptions). */
  readonly tls: ConnectionOptions & Pick<TcpNetConnectOpts, 'autoSelectFamilyAttemptTimeout'>
}

/** The message as it goes on the wire, composed BEFORE connecting (a compose error never meets a socket). */
export interface SmtpPayload {
  readonly envelope: { readonly from: string; readonly to: readonly string[] }
  /** The raw message; opened once, when the server has answered DATA. */
  readonly open: () => Readable
}

/** The server's last reply, and the recipients it turned down (nodemailer's `info.rejected`). */
export interface SmtpReply {
  readonly response: string
  readonly rejected: readonly string[]
}

export interface SmtpTransport {
  /**
   * One message. Resolves with the server's last reply; rejects with nodemailer's error.
   * `onBody` fires when the server has taken DATA and the body starts to go out.
   */
  readonly send: (payload: SmtpPayload, onBody: () => void) => Promise<SmtpReply>
  /** Drops the connection. Safe to call more than once. */
  readonly close: () => void
}

export type ConnectSmtp = (options: SmtpOptions) => SmtpTransport

/** Nothing a config can change. */
export function smtpOptions(server: { readonly host: string; readonly user: string }, password: string): SmtpOptions {
  return {
    host: server.host,
    port: SMTP_PORT,
    secure: true,
    auth: { user: server.user, pass: password },
    // Otherwise the addresses and the subject end up in the daemon's log.
    logger: false,
    debug: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    // The same Happy Eyeballs allowance as imapOptions, for the same VPN (session.ts).
    tls: { minVersion: 'TLSv1.2', autoSelectFamilyAttemptTimeout: 2_500 },
  }
}

/** Production: nodemailer's SMTPConnection, driven by hand so the body can say when it starts. */
export const connectNodemailer: ConnectSmtp = ({ auth, ...options }) => {
  const connection = new SMTPConnection({ ...options, tls: { ...options.tls } })
  return {
    send: (payload, onBody) =>
      new Promise<SmtpReply>((resolve, reject) => {
        // Every failure is also emitted; without a listener that is an uncaught 'error'.
        connection.on('error', reject)
        connection.connect((connectError) => {
          if (connectError) return reject(connectError)
          connection.login({ user: auth.user, pass: auth.pass }, (loginError) => {
            if (loginError) return reject(loginError)
            const envelope = { from: payload.envelope.from, to: [...payload.envelope.to] }
            connection.send(envelope, Readable.from(lazily(payload.open, onBody)), (sendError, info) => {
              if (sendError) return reject(sendError)
              resolve({ response: info?.response ?? '', rejected: info?.rejected ?? [] })
            })
          })
        })
      }),
    close: () => connection.close(),
  }
}

export async function sendMail(input: SendInput, connect: ConnectSmtp = connectNodemailer): Promise<SendResult> {
  if (input.signal.aborted) return { ok: false, phase: 'before-data', reason: STOPPED }
  const secrets = { user: input.user, password: input.password, recipient: input.to }
  // Everything that can fail without a server fails here, before a socket or a timer exists.
  if (!isOneRecipient(input.to)) return { ok: false, phase: 'before-data', reason: INVALID_RECIPIENT }
  const payload = compose(input)
  if (!payload.ok) return { ok: false, phase: 'before-data', reason: reasonOf({ message: `the message could not be composed: ${payload.reason}` }, secrets) }

  const deadline = new AbortController()
  const timer = input.timers.setTimeout(() => deadline.abort(), SEND_DEADLINE_MS)
  const signal = AbortSignal.any([input.signal, deadline.signal])
  let bodyStarted = false
  let transport: SmtpTransport | undefined
  const onAbort = (): void => transport?.close()
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    transport = connect(smtpOptions(input, input.password))
    const reply = await untilAborted(
      transport.send(payload.value, () => {
        bodyStarted = true
      }),
      signal,
    )
    // The server turned the one recipient down: it said it does not take the message (D4).
    if (reply.rejected.length > 0) return { ok: false, phase: 'before-data', reason: RECIPIENT_REJECTED }
    if (!reply.response.startsWith(ACCEPTED)) {
      return { ok: false, phase: 'after-data', reason: reasonOf({ message: `unexpected answer: ${reply.response}` }, secrets) }
    }
    return { ok: true, messageId: input.messageId, response: reply.response }
  } catch (error) {
    if (signal.aborted) {
      const reason = deadline.signal.aborted ? `no answer within ${SEND_DEADLINE_MS / 1000} s` : STOPPED
      return { ok: false, phase: bodyStarted ? 'after-data' : 'before-data', reason }
    }
    return { ok: false, phase: unsent(error) || !bodyStarted ? 'before-data' : 'after-data', reason: reasonOf(error, secrets) }
  } finally {
    timer[Symbol.dispose]()
    signal.removeEventListener('abort', onAbort)
    transport?.close()
  }
}

const INVALID_RECIPIENT = 'invalid-recipient'
const RECIPIENT_REJECTED = 'the server rejected the recipient'
const SINGLE_ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+$/

/**
 * Exactly one BARE address, and no CR/LF anywhere: a `to` with a line break or a comma can parse into
 * a DIFFERENT recipient (or several) than the one the owner approved, and a display name
 * (`"boss@a.com" <x@b.com>`) shows one address in `To:` while the envelope goes to another.
 */
function isOneRecipient(to: string): boolean {
  if (/[\r\n]/.test(to)) return false
  const parsed = addressparser(to)
  const only = parsed[0]
  return parsed.length === 1 && only !== undefined && 'address' in only && SINGLE_ADDRESS.test(only.address ?? '') && to.trim() === only.address
}

/** The MIME tree and its envelope, built before any connection; a throw becomes a reason. */
function compose(input: SendInput): { readonly ok: true; readonly value: SmtpPayload } | { readonly ok: false; readonly reason: string } {
  try {
    const mime = new MailComposer(composed(input)).compile()
    const envelope = mime.getEnvelope()
    return { ok: true, value: { envelope: { from: envelope.from === false ? '' : envelope.from, to: envelope.to }, open: () => mime.createReadStream() } }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Certainly not delivered: a 4xx or 5xx reply (the server said it does not take the message), or
 * `ESTREAM` (our own body failed to read, so the closing dot was never written and the connection
 * is dropped).
 */
function unsent(error: unknown): boolean {
  const record = (error ?? {}) as { responseCode?: unknown; code?: unknown }
  return (typeof record.responseCode === 'number' && record.responseCode >= 400) || record.code === 'ESTREAM'
}

/** Plain text only: there is no HTML to template, and nothing to break (D4). */
function composed(message: SmtpMessage): ConstructorParameters<typeof MailComposer>[0] {
  return {
    from: { name: message.from.name, address: message.from.address },
    to: message.to,
    subject: message.subject,
    text: message.text,
    messageId: message.messageId,
    ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
    ...(message.references === undefined ? {} : { references: [...message.references] }),
    ...(message.attachment === undefined ? {} : { attachments: [{ filename: message.attachment.filename, path: message.attachment.path }] }),
  }
}

/**
 * The message, untouched, but not read until someone reads it — and nodemailer only does once the
 * server has answered DATA. The first read is the moment the body starts to go out.
 */
async function* lazily(source: () => Readable, onFirstRead: () => void): AsyncGenerator<Buffer> {
  onFirstRead()
  for await (const chunk of source()) yield chunk as Buffer
}
