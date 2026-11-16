/**
 * THE PROTOCOL TEST OF `replies/read.ts` (tasks Q1; ADR-0018; guardrail 11; design D4: the inbox's
 * stays the inbox's, and jobs writes its own).
 *
 * The client double tests `readReplies`; this tests what the REAL imapflow puts on the wire on its own
 * account, against the made-up server announcing Gmail's measured CAPABILITY, for a read that matches a
 * reply by its thread and so fetches its body. TLS IS VERIFIED with a CA made for the run.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { connectImapFlow, type ConnectImap } from '@factotum/mail'
import { fetchItems, startFakeImap } from '@factotum/mail/testing'
import { insertApp, queueStore } from '../ai/test-queue.ts'
import { send } from '../test-state.ts'
import { hasOpenssl, imapDate, replyCertificates } from '../test-replies.ts'
import { realTimers, tempBase } from '../test-support.ts'
import { readReplies } from './read.ts'

/** ADR-0018, both lists. A command is its verb, with the `UID` prefix when it has one. */
const FORBIDDEN = ['SELECT', 'STORE', 'COPY', 'MOVE', 'EXPUNGE', 'APPEND', 'CREATE', 'DELETE', 'RENAME', 'SUBSCRIBE', 'UNSUBSCRIBE', 'IDLE']
const ALLOWED = new Set(['CAPABILITY', 'ID', 'NAMESPACE', 'LOGIN', 'AUTHENTICATE', 'LIST', 'LSUB', 'XLIST', 'EXAMINE', 'SEARCH', 'UID SEARCH', 'FETCH', 'UID FETCH', 'NOOP', 'LOGOUT'])
/** FETCH items that set \Seen, by EXACT TOKEN: `RFC822.SIZE` and `RFC822.HEADER` mark nothing. */
const MARKS_SEEN = (item: string): boolean => item === 'RFC822' || item === 'RFC822.TEXT' || item.startsWith('BODY[') || item.startsWith('BINARY[')

const PASSWORD = 'abcdefghijklmnop'
const USER = 'owner.jobs@example.com'

function verbOf(command: string): string {
  const words = command.toUpperCase().split(' ')
  return words[0] === 'UID' ? `UID ${words[1] ?? ''}` : (words[0] ?? '')
}

test('Q1 protocol: the real imapflow reading replies sends only ADR-0018’s commands, EXAMINE and BODY.PEEK, and the body of the matched reply arrives', async (t) => {
  if (!hasOpenssl()) {
    t.skip('openssl is not installed: the protocol test needs it to make a throwaway CA')
    return
  }
  const tls = replyCertificates()
  const now = new Date()
  using base = tempBase()
  const db = await queueStore(base)
  insertApp(db, { id: 'app-1', state: 'sent', sends: [send({ state: 'sent', at: new Date(now.getTime() - 3 * 86_400_000).toISOString() })] })

  const server = await startFakeImap(tls, {
    uid: 4242,
    internalDate: imapDate(new Date(now.getTime() - 3_600_000)),
    subject: 'Re: Application',
    fromName: 'Ada',
    fromAddress: 'ada@acme.example',
    toAddress: USER,
    messageId: '<r1@acme.example>',
    gmailId: '1844674407370955161',
    headers: 'Message-ID: <r1@acme.example>\r\nIn-Reply-To: <m1@jobs.factotum.local>\r\nReferences: <m1@jobs.factotum.local>\r\n\r\n',
    body: 'Can we talk on Monday?\r\n',
  })
  t.after(() => server.close())

  const connect: ConnectImap = (options) =>
    connectImapFlow({ ...options, host: '127.0.0.1', port: server.port, tls: { ...options.tls, ca: tls.ca, servername: 'localhost' } })
  const result = await readReplies({
    db,
    server: { host: 'imap.gmail.com', user: USER },
    password: PASSWORD,
    connect,
    timers: realTimers,
    signal: new AbortController().signal,
    now: () => now,
    timeoutMs: 20_000,
  })

  const commands = server.commands
  const verbs = commands.map(verbOf)
  assert.ok(verbs.includes('EXAMINE'), `no EXAMINE in ${verbs.join(', ')}`)
  for (const verb of verbs) {
    assert.equal(FORBIDDEN.some((bad) => verb === bad || verb === `UID ${bad}`), false, `forbidden ${verb}`)
    assert.ok(ALLOWED.has(verb), `not in the allowed list: ${verb}`)
  }
  const fetches = commands.filter((command) => verbOf(command).endsWith('FETCH'))
  assert.equal(fetches.length, 2, 'the headers, then the body of the matched one')
  for (const command of fetches) {
    for (const item of fetchItems(command).map((token) => token.toUpperCase())) assert.equal(MARKS_SEEN(item), false, `FETCH item marks \\Seen: ${item}`)
  }
  assert.ok(fetches[1]!.toUpperCase().includes('BODY.PEEK[1]<0.65536>'), fetches[1])
  const all = commands.join('\n')
  assert.equal(all.includes(PASSWORD), false)
  assert.equal(all.includes(Buffer.from(`\u0000${USER}\u0000${PASSWORD}`).toString('base64')), false)

  assert.equal(result.ok, true, result.ok ? '' : result.reason)
  if (!result.ok) return
  assert.deepEqual(result.replies.map((r) => [r.key, r.match.kind, r.body]), [['1:4242', 'thread', 'Can we talk on Monday?']])
  t.diagnostic(`commands: ${verbs.join(' → ')}`)
})
