/**
 * A MADE-UP SMTP SERVER, over implicit TLS on loopback, for the sender's test (spec 2026-11-12, D4;
 * task M5). Test-only, excluded from coverage.
 *
 * It stands in front of the REAL nodemailer, writes down every command it receives and every message,
 * and can be told to CUT at any step of the protocol — drop the socket, fall silent, or answer with a
 * line of its own — so the test can measure what nodemailer reports at each one (task M6).
 *
 * THE CREDENTIAL IS NEVER RECORDED: an `AUTH PLAIN` line is written down as its verb and mechanism
 * only, and the SASL continuation after a bare `AUTH PLAIN` is not written down at all.
 *
 * What it announces after EHLO is Gmail's usual list on 465 (not a measurement of A1): AUTH PLAIN is
 * offered, so nodemailer picks it, as it did against Gmail in A1(d); PIPELINING is offered, so the
 * envelope and DATA arrive in one batch, as they would there.
 */

import { createServer, type Server, type TLSSocket } from 'node:tls'
import type { AddressInfo } from 'node:net'

export const GMAIL_EHLO = [
  'smtp.gmail.com at your service',
  'SIZE 35882577',
  '8BITMIME',
  'AUTH LOGIN PLAIN XOAUTH2 PLAIN-CLIENTTOKEN OAUTHBEARER XOAUTH',
  'ENHANCEDSTATUSCODES',
  'PIPELINING',
  'CHUNKING',
  'SMTPUTF8',
] as const

/** A1(d), in Gmail's two lines. */
export const GMAIL_BAD_CREDENTIALS = [
  '535-5.7.8 Username and Password not accepted. For more information, go to',
  '535 5.7.8  https://support.google.com/mail/?p=BadCredentials a1b2c3d4e5f6 - gsmtp',
] as const

/** The shape measured in A1(b): two spaces after OK, then an epoch and an id. */
export const GMAIL_ACCEPTED = '250 2.0.0 OK  1763000000 a1b2c3d4e5f6 - gsmtp'

/** `greeting` is the moment the TLS handshake ends; `message` is the end of the body (the lone dot). */
export type SmtpStep = 'greeting' | 'EHLO' | 'AUTH' | 'MAIL FROM' | 'RCPT TO' | 'DATA' | 'message'

export interface SmtpCut {
  readonly at: SmtpStep
  /** `close` drops the socket; `silent` never answers again; any other string is the reply line. */
  readonly how: 'close' | 'silent' | string
}

export interface FakeSmtpOptions {
  readonly user: string
  readonly password: string
  readonly cut?: SmtpCut
}

export interface FakeSmtpServer {
  readonly port: number
  /** Every command line, credentials never: `EHLO`, `AUTH PLAIN`, `MAIL FROM:<a@b>`, … */
  readonly commands: string[]
  /** Every message received whole, dot-unstuffed, CRLF kept. */
  readonly messages: string[]
  readonly close: () => Promise<void>
}

export async function startFakeSmtp(tls: { key: string; cert: string }, options: FakeSmtpOptions): Promise<FakeSmtpServer> {
  const commands: string[] = []
  const messages: string[] = []
  const sockets = new Set<TLSSocket>()
  const server: Server = createServer({ key: tls.key, cert: tls.cert }, (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    serve(socket, options, commands, messages)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
    commands,
    messages,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function serve(socket: TLSSocket, options: FakeSmtpOptions, commands: string[], messages: string[]): void {
  let buffer = ''
  let silent = false
  let inData = false
  let body: string[] = []
  let credentialNext = false
  let senderRefused = false
  let accepted = 0

  const send = (...lines: readonly string[]): void => void socket.write(lines.map((line) => `${line}\r\n`).join(''))

  /** True when the cut fired here and the step must not be answered normally. */
  const cutAt = (step: SmtpStep): boolean => {
    if (options.cut?.at !== step) return false
    if (options.cut.how === 'close') socket.destroy()
    else if (options.cut.how === 'silent') silent = true
    else send(options.cut.how)
    return true
  }

  if (cutAt('greeting')) return
  send('220 smtp.gmail.com ESMTP a1b2c3d4e5f6 - gsmtp')

  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const end = buffer.indexOf('\r\n')
      if (end === -1 || silent || socket.destroyed) return
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      if (inData) dataLine(line)
      else if (credentialNext) credential(line)
      else command(line)
    }
  })

  function dataLine(line: string): void {
    if (line !== '.') {
      body.push(line.startsWith('..') ? line.slice(1) : line)
      return
    }
    inData = false
    messages.push(`${body.join('\r\n')}\r\n`)
    body = []
    if (cutAt('message')) return
    send(GMAIL_ACCEPTED)
  }

  function credential(line: string): void {
    // The SASL continuation: the credential. Checked, never written down.
    credentialNext = false
    login(line)
  }

  function login(initial: string): void {
    const [, user, password] = Buffer.from(initial, 'base64').toString('utf8').split('\0')
    if (user === options.user && password === options.password) send('235 2.7.0 Accepted')
    else send(...GMAIL_BAD_CREDENTIALS)
  }

  function command(line: string): void {
    const upper = line.toUpperCase()
    if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
      commands.push('EHLO')
      if (cutAt('EHLO')) return
      const lines = GMAIL_EHLO.map((text, index) => `250${index === GMAIL_EHLO.length - 1 ? ' ' : '-'}${text}`)
      send(...lines)
      return
    }
    if (upper.startsWith('AUTH ')) {
      const [, mechanism = '', initial] = line.split(' ')
      commands.push(`AUTH ${mechanism.toUpperCase()}`)
      if (cutAt('AUTH')) return
      if (mechanism.toUpperCase() !== 'PLAIN') return send('504 5.7.4 Unrecognized authentication type')
      if (initial === undefined) {
        credentialNext = true
        return send('334 ')
      }
      return login(initial)
    }
    if (upper.startsWith('MAIL FROM:')) {
      commands.push(`MAIL FROM:${addressIn(line)}`)
      senderRefused = cutAt('MAIL FROM')
      if (!senderRefused) send('250 2.1.0 OK a1b2c3d4e5f6 - gsmtp')
      return
    }
    if (upper.startsWith('RCPT TO:')) {
      commands.push(`RCPT TO:${addressIn(line)}`)
      if (senderRefused) return send('503 5.5.1 MAIL first.')
      if (cutAt('RCPT TO')) return
      accepted += 1
      return send('250 2.1.5 OK a1b2c3d4e5f6 - gsmtp')
    }
    if (upper === 'DATA') {
      commands.push('DATA')
      if (senderRefused || accepted === 0) return send('503 5.5.1 RCPT first.')
      if (cutAt('DATA')) return
      inData = true
      return send('354 Go ahead a1b2c3d4e5f6 - gsmtp')
    }
    if (upper === 'QUIT') {
      commands.push('QUIT')
      send('221 2.0.0 closing connection a1b2c3d4e5f6 - gsmtp')
      socket.end()
      return
    }
    commands.push(upper.split(' ')[0] ?? '')
    send('502 5.5.1 Unrecognized command.')
  }
}

function addressIn(line: string): string {
  return /<[^>]*>/.exec(line)?.[0] ?? ''
}
