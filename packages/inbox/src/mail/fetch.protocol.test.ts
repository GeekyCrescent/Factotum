/**
 * THE ONE PROTOCOL TEST (spec 2026-10-05, B7b; criterion 6; guardrail 1).
 *
 * The client double tests `fetchAccount`; this tests what the REAL imapflow 2.2.5 puts on the wire
 * on its own account — LIST before EXAMINE, the AUTHENTICATE continuation, the FETCH items of
 * `download()` — against a server announcing Gmail's measured CAPABILITY.
 *
 * TLS IS VERIFIED: the CA made for this run is handed to imapflow as `tls: { ca }`. Never
 * `rejectUnauthorized: false` (guardrail 6). No private key is versioned: openssl makes them here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountConfig } from '../config.ts'
import { fetchItems, startFakeImap } from '../test-imap-server.ts'
import { realTimers } from '../test-support.ts'
import { connectImapFlow, type ConnectImap } from './client.ts'
import { fetchAccount } from './fetch.ts'

/** Guardrail 1, both lists. A command is its verb, with the `UID` prefix when it has one. */
const FORBIDDEN = ['SELECT', 'STORE', 'COPY', 'MOVE', 'EXPUNGE', 'APPEND', 'CREATE', 'DELETE', 'RENAME', 'SUBSCRIBE', 'UNSUBSCRIBE', 'IDLE']
const ALLOWED = new Set([
  'CAPABILITY',
  'ID',
  'NAMESPACE',
  'LOGIN',
  'AUTHENTICATE',
  'LIST',
  'LSUB',
  'XLIST',
  'EXAMINE',
  'SEARCH',
  'UID SEARCH',
  'FETCH',
  'UID FETCH',
  'NOOP',
  'LOGOUT',
])
/** FETCH items that set \Seen. Compared by EXACT TOKEN: `RFC822.SIZE` and `RFC822.HEADER` mark nothing. */
const MARKS_SEEN = (item: string): boolean =>
  item === 'RFC822' || item === 'RFC822.TEXT' || item.startsWith('BODY[') || item.startsWith('BINARY[')

const PASSWORD = 'abcdefghijklmnop'

function verbOf(command: string): string {
  const words = command.toUpperCase().split(' ')
  return words[0] === 'UID' ? `UID ${words[1] ?? ''}` : (words[0] ?? '')
}

function openssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function certificates(): Promise<{ ca: string; key: string; cert: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'factotum-inbox-tls-'))
  const run = (args: readonly string[]): void => void execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1',
    '-subj', '/CN=factotum-test-ca', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign'])
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost'])
  await writeFile(join(dir, 'ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
  run(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.crt', '-days', '1', '-extfile', 'ext'])
  const read = (name: string) => readFile(join(dir, name), 'utf8')
  return { ca: await read('ca.crt'), key: await read('srv.key'), cert: await read('srv.crt') }
}

function imapDate(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getUTCDate())}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
}

test('the real imapflow, against Gmail’s CAPABILITY: nothing forbidden goes out, everything that goes out is allowed (criterion 6)', async (t) => {
  if (!openssl()) {
    t.skip('openssl is not installed: the protocol test needs it to make a throwaway CA')
    return
  }
  const tls = await certificates()
  const now = new Date()
  const server = await startFakeImap(tls, {
    uid: 4242,
    internalDate: imapDate(new Date(now.getTime() - 3600_000)),
    subject: 'Assignment due Friday',
    fromName: 'Prof',
    fromAddress: 'prof@mq.edu.au',
    toAddress: 'me@students.mq.edu.au',
    messageId: '<p1@mq.edu.au>',
    gmailId: '1844674407370955161',
    headers: 'Resent-From: me@students.mq.edu.au\r\nList-Unsubscribe: <mailto:u@mq.edu.au>\r\n\r\n',
    body: 'Please submit the report by Friday.\r\n',
  })
  t.after(() => server.close())

  // THE SEAM: fetchAccount's own options, pointed at loopback, with the CA of this run.
  const seen: Record<string, unknown>[] = []
  const connect: ConnectImap = (options) => {
    seen.push({ ...options })
    return connectImapFlow({ ...options, host: '127.0.0.1', port: server.port, tls: { ...options.tls, ca: tls.ca, servername: 'localhost' } })
  }
  const account: AccountConfig = {
    id: 'personal',
    label: 'Gmail',
    host: 'imap.gmail.com',
    user: 'cuenta@gmail.com',
    passwordFile: '/secret',
    read: 'unread',
    sources: [{ id: 'mq', label: 'Macquarie', address: 'me@students.mq.edu.au', read: 'all' }],
  }

  const result = await fetchAccount({
    account,
    password: PASSWORD,
    since: new Date(now.getTime() - 48 * 3600_000),
    signal: new AbortController().signal,
    connect,
    timers: realTimers,
    maxBodies: 400,
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
  assert.ok(fetches.length >= 2, 'the envelope fetch and the download')
  for (const command of fetches) {
    for (const item of fetchItems(command).map((token) => token.toUpperCase())) {
      assert.equal(MARKS_SEEN(item), false, `FETCH item marks \\Seen: ${item}`)
    }
  }
  // The credential never reached the log of commands, in clear or in base64.
  const all = commands.join('\n')
  assert.equal(all.includes(PASSWORD), false)
  assert.equal(all.includes(Buffer.from(`\u0000cuenta@gmail.com\u0000${PASSWORD}`).toString('base64')), false)
  assert.equal(result.ok, true, result.ok ? '' : result.reason)
  if (!result.ok) return
  assert.equal(result.mails.length, 1)
  const [mail] = result.mails
  assert.equal(mail!.uid, 4242)
  assert.equal(mail!.sourceId, 'mq')
  assert.equal(mail!.gmailId, '1844674407370955161')
  assert.equal(mail!.unsubscribe, true)
  assert.equal(mail!.body, 'Please submit the report by Friday.')
  assert.equal(seen[0]?.rejectUnauthorized, undefined)

  t.diagnostic(`commands: ${verbs.join(' → ')}`)
})
