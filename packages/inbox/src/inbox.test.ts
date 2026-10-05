import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConnectImap } from './mail/client.ts'
import { imapDouble, type FakeMail, type ImapDouble } from './test-imap-client.ts'
import { capturedLog, eventually, manualTimers, type ManualTimers } from './test-support.ts'
import { BATCH_SIZE, createInbox, RUN_TIMEOUT_MS, type ProgressHook } from './inbox.ts'
import type { Inbox, Progress } from './types.ts'

const FAKE = fileURLToPath(new URL('../test/fixtures/fake-claude.mjs', import.meta.url))
const NOW = new Date('2026-10-06T08:00:00.000Z')
const SUBJECT = 'Confidential subject line'
const SENDER = 'secret.sender@example.com'
const BODY = 'the body text nobody may log'

function mails(count: number): FakeMail[] {
  return Array.from({ length: count }, (_, index) => ({
    uid: index + 1,
    internalDate: new Date(NOW.getTime() - (index + 1) * 60_000),
    from: { name: 'Secret Sender', address: SENDER },
    subject: `${SUBJECT} ${index}`,
    messageId: `<m${index}@example.com>`,
    parts: { '1': `${BODY} ${index}` },
  }))
}

interface RigOptions {
  readonly doubles?: Readonly<Record<string, ImapDouble>>
  readonly modes?: readonly string[]
  readonly config?: (stateDir: string, secret: string) => Readonly<Record<string, unknown>>
  readonly before?: (stateDir: string) => Promise<void>
  readonly onProgress?: ProgressHook
}

async function rig(options: RigOptions = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'factotum-inbox-facade-'))
  const secret = join(stateDir, 'secret')
  await writeFile(secret, 'abcd efgh ijkl mnop\n')
  await chmod(secret, 0o600)
  await mkdir(join(stateDir, 'run'), { recursive: true })
  await writeFile(join(stateDir, 'run', 'fake-claude.modes'), `${(options.modes ?? ['ok']).join('\n')}\n`)
  await options.before?.(stateDir)
  const doubles = options.doubles ?? { 'imap.gmail.com': imapDouble(mails(3)) }
  const connect: ConnectImap = (opts) => {
    const double = doubles[opts.host ?? '']
    if (double === undefined) throw new Error(`no double for ${opts.host}`)
    return double.connect(opts)
  }
  const accounts = Object.keys(doubles).map((host, index) => ({
    id: `acct${index}`,
    label: `Account ${index}`,
    host,
    user: `user${index}@example.com`,
    passwordFile: secret,
    read: 'all',
  }))
  const manual: ManualTimers = manualTimers()
  const { log, lines } = capturedLog()
  const created = await createInbox({
    config: options.config?.(stateDir, secret) ?? { accounts },
    stateDir,
    log,
    now: () => NOW,
    timers: manual.timers,
    bin: FAKE,
    connect,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  })
  const pids = async (): Promise<number[]> => {
    try {
      return (await readFile(join(stateDir, 'run', 'fake-claude.calls'), 'utf8')).trim().split('\n').map(Number)
    } catch {
      return []
    }
  }
  return { created, stateDir, manual, lines, pids, doubles }
}

function inboxOf(created: Awaited<ReturnType<typeof createInbox>>): Inbox {
  if (!created.ok) throw new Error(created.reason)
  return created.inbox
}

async function finished(inbox: Inbox): Promise<void> {
  await eventually(() => !inbox.status().running, 'the run finished')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a bad config is ok:false with a reason that does not carry the value (criterion 1)', async () => {
  const { created } = await rig({ config: () => ({ model: 'claude opus', accounts: [] }) })
  assert.equal(created.ok, false)
  assert.equal(created.ok ? '' : created.reason.includes('claude opus'), false)
  assert.match(created.ok ? '' : created.reason, /^inbox\.model: /)
})

test('an empty stateDir: run/ and digests/ are made, and the first run does not meet ENOENT', async () => {
  const { created, stateDir } = await rig()
  const inbox = inboxOf(created)
  assert.deepEqual((await readdir(stateDir)).sort(), ['digests', 'run', 'secret'])
  const started = inbox.runNow()
  assert.equal(started.outcome, 'started')
  await finished(inbox)
  const latest = await inbox.latest()
  assert.equal(latest?.state, 'ok')
  assert.equal(latest?.id, started.outcome === 'started' ? started.id : '')
})

test('an old digest is pruned when the inbox is created (criterion 23)', async () => {
  const { created, stateDir } = await rig({
    before: async (dir) => {
      await mkdir(join(dir, 'digests'))
      await writeFile(join(dir, 'digests', '2026-08-01T0800.json'), '{}')
      await writeFile(join(dir, 'digests', '2026-10-05T0800.json'), '{}')
    },
  })
  inboxOf(created)
  assert.deepEqual(await readdir(join(stateDir, 'digests')), ['2026-10-05T0800.json'])
})

test('status: the configured accounts with no state before the first run, and the last state after (criterion 2)', async () => {
  const { created } = await rig()
  const inbox = inboxOf(created)
  assert.deepEqual(inbox.status(), { running: false, accounts: [{ id: 'acct0', label: 'Account 0' }] })
  inbox.runNow()
  await finished(inbox)
  const status = inbox.status()
  assert.equal(status.running, false)
  assert.deepEqual(status.accounts, [{ id: 'acct0', label: 'Account 0', last: { id: 'acct0', label: 'Account 0', state: 'ok', eligible: 3 } }])
})

test('a full run leaves one ok file with every mail classified, and list/get find it (criteria 5, 21)', async () => {
  const { created, stateDir } = await rig({ modes: ['action'] })
  const inbox = inboxOf(created)
  inbox.runNow()
  await finished(inbox)
  const files = await readdir(join(stateDir, 'digests'))
  assert.equal(files.length, 1)
  const digest = await inbox.latest()
  assert.equal(digest?.state, 'ok')
  assert.deepEqual(digest?.entries.map((entry) => [entry.key, entry.category]), [
    ['acct0:1', 'action'],
    ['acct0:2', 'action'],
    ['acct0:3', 'action'],
  ])
  assert.equal(digest?.usage.batches, 1)
  assert.deepEqual(await inbox.get(digest!.id), digest)
  assert.deepEqual((await inbox.list(30)).map((summary) => [summary.id, summary.todo, summary.high]), [[digest!.id, 3, 3]])
})

test('runNow during a run is busy (criterion 19)', async () => {
  const { created, pids } = await rig({ modes: ['hang'] })
  const inbox = inboxOf(created)
  assert.equal(inbox.runNow().outcome, 'started')
  assert.deepEqual(inbox.runNow(), { outcome: 'busy' })
  await eventually(async () => (await pids()).length === 1, 'claude started')
  assert.deepEqual(inbox.runNow(), { outcome: 'busy' })
  await inbox.stop()
  assert.equal(inbox.status().running, false)
  assert.deepEqual(inbox.runNow(), { outcome: 'busy' })
})

test('status goes through reading, classifying and saving (criterion 18)', async () => {
  const seen: (Progress | undefined)[] = []
  let inbox: Inbox | undefined
  const { created } = await rig({
    doubles: { 'imap.gmail.com': imapDouble(mails(BATCH_SIZE + 1)), 'imap.other.com': imapDouble(mails(1)) },
    onProgress: () => seen.push(inbox?.status().progress),
  })
  inbox = inboxOf(created)
  inbox.runNow()
  await finished(inbox)
  assert.deepEqual(seen, [
    { step: 'reading', account: 1, of: 2 },
    { step: 'reading', account: 2, of: 2 },
    { step: 'classifying', batch: 1, of: 2 },
    { step: 'classifying', batch: 2, of: 2 },
    { step: 'saving' },
  ])
  assert.equal(inbox.status().progress, undefined)
})

test('an account that fails makes the run partial, and the other account is there (criterion 9)', async () => {
  const { created, lines } = await rig({
    doubles: {
      'imap.gmail.com': imapDouble(mails(2)),
      'imap.bad.com': imapDouble([], { refuseLogin: { response: '[AUTHENTICATIONFAILED] Invalid credentials' } }),
    },
  })
  const inbox = inboxOf(created)
  inbox.runNow()
  await finished(inbox)
  const digest = await inbox.latest()
  assert.equal(digest?.state, 'partial')
  assert.deepEqual(digest?.accounts.map((account) => [account.id, account.state, account.eligible]), [
    ['acct0', 'ok', 2],
    ['acct1', 'failed', 0],
  ])
  assert.equal(digest?.accounts[1]?.reason, 'login refused: [AUTHENTICATIONFAILED] Invalid credentials')
  assert.equal(digest?.entries.length, 2)
  assert.ok(lines.some((line) => line.startsWith('warn run ') && line.includes('account acct1 failed: login refused')))
})

test('a password file that is not 0600 fails that account only (criterion 2)', async () => {
  const { created } = await rig({
    before: async (dir) => void (await writeFile(join(dir, 'loose'), 'abcd\n', { mode: 0o644 })),
    config: (dir, secret) => ({
      accounts: [
        { id: 'good', label: 'Good', host: 'imap.gmail.com', user: 'u@x.com', passwordFile: secret },
        { id: 'loose', label: 'Loose', host: 'imap.gmail.com', user: 'v@x.com', passwordFile: join(dir, 'loose') },
      ],
    }),
  })
  const inbox = inboxOf(created)
  inbox.runNow()
  await finished(inbox)
  const digest = await inbox.latest()
  assert.deepEqual(digest?.accounts.map((account) => [account.id, account.state]), [
    ['good', 'ok'],
    ['loose', 'failed'],
  ])
  assert.match(digest?.accounts[1]?.reason ?? '', /readable by others/)
  assert.equal(digest?.state, 'partial')
})

test('THE CAP with one batch done and one hung: partial, the first saved, the second unclassified, claude dead, IMAP closed (criterion 20)', async () => {
  const double = imapDouble(mails(BATCH_SIZE + 5))
  const { created, manual, pids } = await rig({ doubles: { 'imap.gmail.com': double }, modes: ['ok', 'hang'] })
  const inbox = inboxOf(created)
  inbox.runNow()
  await eventually(async () => (await pids()).length === 2, 'the second batch started')
  assert.equal(manual.fire(RUN_TIMEOUT_MS), 1)
  await finished(inbox)
  const digest = await inbox.latest()
  assert.equal(digest?.state, 'partial')
  assert.match(digest?.reason ?? '', /^timed out after 15 min; 1 of 2 batches failed: stopped$/)
  const categories = digest?.entries.map((entry) => entry.category) ?? []
  assert.equal(categories.filter((category) => category === 'info').length, BATCH_SIZE)
  assert.equal(categories.filter((category) => category === 'unclassified').length, 5)
  const [, second] = await pids()
  await eventually(() => !alive(second!), 'the hung claude is gone')
  assert.ok(double.calls.some((call) => call.method === 'logout' || call.method === 'close'), 'IMAP was closed')
})

test('the cap with no batch done: failed (criterion 20)', async () => {
  const { created, manual, pids } = await rig({ modes: ['hang'] })
  const inbox = inboxOf(created)
  inbox.runNow()
  await eventually(async () => (await pids()).length === 1, 'the batch started')
  manual.fire(RUN_TIMEOUT_MS)
  await finished(inbox)
  const digest = await inbox.latest()
  assert.equal(digest?.state, 'failed')
  assert.match(digest?.reason ?? '', /^timed out after 15 min/)
  assert.deepEqual(digest?.entries.map((entry) => entry.category), ['unclassified', 'unclassified', 'unclassified'])
})

test('the run’s log has counts, tokens, cost and time — never a sender, a subject or a body (criterion 27)', async () => {
  const { created, lines } = await rig({ modes: ['action'] })
  const inbox = inboxOf(created)
  inbox.runNow()
  await finished(inbox)
  const summary = lines.find((line) => line.startsWith('info run ') && line.includes(' ok: '))
  assert.match(summary ?? '', /^info run \S+ ok: acct0 3 mails; 1 batches \(0 failed\); 1510 tokens in, 300 out; \$0\.012; 0 s$/)
  const all = lines.join('\n')
  for (const secret of [SUBJECT, SENDER, 'Secret Sender', BODY, 'abcdefghijklmnop']) assert.equal(all.includes(secret), false, secret)
})

test('stop on an idle inbox is quiet, and stop during a run waits for its file', async () => {
  const idle = inboxOf((await rig()).created)
  await idle.stop()
  const { created, pids } = await rig({ modes: ['hang'] })
  const inbox = inboxOf(created)
  inbox.runNow()
  await eventually(async () => (await pids()).length === 1, 'claude started')
  await inbox.stop()
  const digest = await inbox.latest()
  assert.equal(digest?.state, 'failed')
  assert.match(digest?.reason ?? '', /^stopped/)
})
