/**
 * THE PRODUCTION SEAM AGAINST A MADE-UP SERVER (spec 2026-11-12, M3b; R71).
 *
 * `connectImapFlow` builds the REAL imapflow, here with `imapOptions` pointed at `startFakeImap` on
 * loopback. TLS IS VERIFIED against a CA made for this run (`tls: { ca }`); verification is
 * never switched off (guardrail 6). What a whole run puts on the wire is `inbox`'s protocol
 * test; this is the seam itself: EXAMINE, SEARCH, one header FETCH, LOGOUT — and an `error` on the
 * client that does not end the process.
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import type { EventEmitter } from 'node:events'
import { startFakeImap, type ServedMail } from '../testing.ts'
import { certificates, hasOpenssl } from '../test-support.ts'
import { connectImapFlow, type ImapOptions, type MetaQuery } from './client.ts'
import { imapOptions } from './session.ts'

const USER = 'cuenta@gmail.com'
const PASSWORD = 'abcdefghijklmnop'

let tls: { ca: string; key: string; cert: string } | undefined

before(async () => {
  if (hasOpenssl()) tls = await certificates()
})

function imapDate(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getUTCDate())}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
}

const MAIL: ServedMail = {
  uid: 4242,
  internalDate: imapDate(new Date(Date.now() - 3_600_000)),
  subject: 'Assignment due Friday',
  fromName: 'Prof',
  fromAddress: 'prof@mq.edu.au',
  toAddress: 'me@students.mq.edu.au',
  messageId: '<p1@mq.edu.au>',
  gmailId: '1844674407370955161',
  headers: 'List-Unsubscribe: <mailto:u@mq.edu.au>\r\n\r\n',
  body: 'Please submit the report by Friday.\r\n',
}

/** The production options, with only the address and the CA of this run changed. */
function loopback(port: number, ca: string): ImapOptions {
  const options = imapOptions({ host: 'imap.gmail.com', user: USER }, PASSWORD)
  return { ...options, host: '127.0.0.1', port, tls: { ...options.tls, ca, servername: 'localhost' } }
}

test('connectImapFlow over verified TLS: EXAMINE, SEARCH, a header FETCH and LOGOUT', async (t) => {
  if (tls === undefined) {
    t.skip('openssl is not installed: the client test needs it to make a throwaway CA')
    return
  }
  const server = await startFakeImap(tls, MAIL)
  t.after(() => server.close())
  const client = connectImapFlow(loopback(server.port, tls.ca))
  const query: MetaQuery = { envelope: true, flags: true, bodyStructure: true, internalDate: true, headers: ['List-Unsubscribe'] }

  await client.connect()
  await client.mailboxOpen('INBOX', { readOnly: true })
  const uids = await client.search({ since: new Date(Date.now() - 48 * 3_600_000) }, { uid: true })
  const messages = await client.fetchAll(String(MAIL.uid), query, { uid: true })
  await client.logout()

  assert.deepEqual(uids, [MAIL.uid])
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.uid, MAIL.uid)
  assert.equal(messages[0]?.envelope?.subject, MAIL.subject)
  assert.equal(messages[0]?.headers?.toString('utf8'), MAIL.headers)

  const commands = server.commands.map((command) => command.toUpperCase())
  assert.ok(commands.some((command) => command.startsWith('EXAMINE ')), `no EXAMINE in ${commands.join(', ')}`)
  assert.equal(commands.some((command) => command.startsWith('SELECT ')), false, 'SELECT went out')
  assert.ok(commands.some((command) => command.startsWith('UID SEARCH ')), 'no UID SEARCH')
  const fetch = commands.find((command) => command.startsWith('UID FETCH '))
  assert.ok(fetch?.includes('BODY.PEEK[HEADER.FIELDS (LIST-UNSUBSCRIBE)]'), `no header FETCH: ${fetch}`)
  assert.equal(commands.at(-1), 'LOGOUT')
  assert.equal(server.commands.some((command) => command.includes(PASSWORD)), false, 'the password was recorded')
})

test('connectImapFlow verifies the certificate: without this run’s CA the login never happens', async (t) => {
  if (tls === undefined) {
    t.skip('openssl is not installed: the client test needs it to make a throwaway CA')
    return
  }
  const server = await startFakeImap(tls, MAIL)
  t.after(() => server.close())
  const options = imapOptions({ host: 'imap.gmail.com', user: USER }, PASSWORD)
  const client = connectImapFlow({ ...options, host: '127.0.0.1', port: server.port, tls: { ...options.tls, servername: 'localhost' } })

  await assert.rejects(client.connect())
  client.close()

  assert.equal(server.commands.some((command) => command.startsWith('AUTHENTICATE') || command === 'LOGIN'), false)
})

test('an `error` on the client (a socket reset mid-run) does not end the process', () => {
  const client = connectImapFlow(imapOptions({ host: '127.0.0.1', user: USER }, PASSWORD))
  // The seam hides that it is an EventEmitter; the listener is what is under test.
  const emitter = client as unknown as EventEmitter

  assert.equal(emitter.listenerCount('error'), 1)
  assert.doesNotThrow(() => emitter.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })))
  client.close()
})
