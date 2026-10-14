import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commitAll, put, sh } from '../test-repos.ts'
import { addSession, apiRoute, linked, manualTimers, type Linked, type TestHost } from '../test-handoff.ts'
import { uuidv7 } from '../id.ts'
import type { SessionStore } from '../store.ts'
import { createHandoff, type HandoffApi } from './index.ts'
import { newJournal, readJournal, writeJournal, type Journal } from './journal.ts'

const FAST = { source: { sleep: async () => undefined, statusWaitMs: 20, statusPollMs: 5 } }
const there = async (path: string) => (await lstat(path).catch(() => undefined)) !== undefined
const never = () => new Promise<never>(() => undefined)

async function scene() {
  const l = await linked({ handoff: FAST })
  await put(l.w.source, 'local.md', 'local\n')
  await commitAll(l.w.env, l.w.source, 'local')
  await put(l.w.source, 'a.txt', 'changed\n')
  const session = await addSession(l.mac, { siteId: 'vault', transcript: '{"t":1}\n' })
  return { l, session }
}

/** The daemon comes back: a NEW handoff over the same disk, as `createEngine` makes one. */
function restart(side: TestHost, extra: Partial<TestHost['host']> = {}): HandoffApi {
  return createHandoff({ ...side.host, ...extra }, FAST)
}

/** Starts a handoff that will hang at `step` — the daemon "dies" there. Answers its hid once the step is reached. */
async function hangAt(l: Linked, step: string): Promise<string> {
  const next = l.toOmarchy.route!
  let reached = () => undefined as void
  const at = new Promise<void>((resolve) => (reached = resolve))
  l.toOmarchy.route = async (method, path, body, file) => {
    if (path.endsWith(step)) {
      reached()
      return await never()
    }
    return await next(method, path, body, file)
  }
  const started = await l.mac.api.start({ to: 'omarchy' })
  await at
  return started.kind === 'ok' ? (started.body as { hid: string }).hid : ''
}

const holders = async (h: TestHost, siteId: string) => (await h.host.locks.holders(siteId)).map((x) => x?.sessionId)

// ---------------------------------------------------------------------------
// J14a — the source's rows
// ---------------------------------------------------------------------------

test('locking at a restart: the holder goes and the journal says aborted — the peer knew nothing', async () => {
  const { l } = await scene()
  const hid = uuidv7(Date.now())
  await writeJournal(l.mac.host.paths, { ...newJournal({ hid, siteId: 'vault', role: 'source', peer: 'omarchy', phase: 'locking', at: 'x' }), peerSiteId: 'obsidian' })
  await l.mac.host.locks.acquire('vault', `handoff-${hid}`, 'x')
  await restart(l.mac).atStart()
  assert.equal((await readJournal(l.mac.host.paths, hid, 'vault'))?.phase, 'aborted')
  assert.deepEqual(await holders(l.mac, 'vault'), [])
})

test('sending at a restart, with the peer DOWN: aborted here and let go without it; once it is back, one abort is sent (D11)', async () => {
  const { l, session } = await scene()
  const hid = await hangAt(l, '/file/1')
  assert.equal((await readJournal(l.mac.host.paths, hid, 'vault'))?.phase, 'sending')
  l.toOmarchy.reachable = false
  const again = createHandoff(l.mac.host, FAST)
  await again.atStart()
  assert.equal((await readJournal(l.mac.host.paths, hid, 'vault'))?.phase, 'sending', 'moment 1 touches no git')
  await again.afterStart()
  assert.equal((await readJournal(l.mac.host.paths, hid, 'vault'))?.phase, 'aborted')
  assert.deepEqual(await holders(l.mac, 'vault'), [])
  assert.equal((await l.mac.host.store.readMeta(session.id))?.movedTo, undefined)
  // The peer is back: moment 3 sends the abort, ONCE.
  const sent: string[] = []
  l.toOmarchy.reachable = true
  l.toOmarchy.route = async (method, path, body, file) => (sent.push(path), await apiRoute(l.omarchy.api, l.omarchy.home)(method, path, body, file))
  await again.poll()
  await again.poll()
  assert.deepEqual(sent, [`handoff/${hid}/obsidian/abort`])
  assert.equal((await readJournal(l.omarchy.host.paths, hid, 'obsidian'))?.phase, 'aborted')
})

test('committing at a restart becomes pending-peer in moment 1; when the peer answers prepared, the source asks it to abort and aborts here (D11)', async () => {
  const { l } = await scene()
  const hid = await hangAt(l, '/commit')
  assert.equal((await readJournal(l.mac.host.paths, hid, 'vault'))?.phase, 'committing')
  // The link back, working again for the restarted daemon.
  const again = createHandoff(l.mac.host, FAST)
  l.toOmarchy.route = apiRoute(l.omarchy.api, l.omarchy.home)
  await again.atStart()
  assert.equal((await readJournal(l.mac.host.paths, hid, 'vault'))?.phase, 'pending-peer')
  await again.poll()
  assert.equal((await readJournal(l.mac.host.paths, hid, 'vault'))?.phase, 'aborted')
  assert.equal((await readJournal(l.omarchy.host.paths, hid, 'obsidian'))?.phase, 'aborted')
  assert.deepEqual(await holders(l.mac, 'vault'), [])
  assert.deepEqual(await holders(l.omarchy, 'obsidian'), [])
})

test('a pending-peer from a restart is let go by «Keep them here» (criterion 32b)', async () => {
  const { l, session } = await scene()
  const hid = await hangAt(l, '/commit')
  const again = createHandoff(l.mac.host, FAST)
  await again.atStart()
  assert.equal((await again.keep(hid, 'vault')).kind, 'ok')
  assert.equal((await readJournal(l.mac.host.paths, hid, 'vault'))?.phase, 'kept')
  assert.deepEqual(await holders(l.mac, 'vault'), [])
  assert.equal((await l.mac.host.store.readMeta(session.id))?.movedTo, undefined)
})

test('acked at a restart: cleaned, done and let go WITHOUT the peer (the done is not retried)', async () => {
  const { l } = await scene()
  const hid = uuidv7(Date.now())
  const head = await sh(l.w.env, l.w.source, 'rev-parse', 'HEAD')
  const tree = await sh(l.w.env, l.w.source, 'rev-parse', 'HEAD^{tree}')
  await sh(l.w.env, l.w.source, 'checkout', '--quiet', '--', '.')
  await writeJournal(l.mac.host.paths, { ...newJournal({ hid, siteId: 'vault', role: 'source', peer: 'omarchy', phase: 'acked', at: 'x' }), peerSiteId: 'obsidian', head, tree })
  await l.mac.host.locks.acquire('vault', `handoff-${hid}`, 'x')
  l.toOmarchy.reachable = false
  const again = createHandoff(l.mac.host, FAST)
  await again.atStart()
  await again.afterStart()
  assert.equal((await readJournal(l.mac.host.paths, hid, 'vault'))?.phase, 'done')
  assert.deepEqual(await holders(l.mac, 'vault'), [])
})

test('start() calls neither git nor the peer: with no git on the PATH and the link counting, moment 1 still decides every row', async () => {
  const { l } = await scene()
  const hid = await hangAt(l, '/commit')
  const calls: string[] = []
  const down = { ok: false, status: undefined, reason: 'unreachable', body: undefined } as const
  const peers = {
    ...l.mac.host.peers,
    json: async (...args: unknown[]) => (calls.push(String(args[2])), down),
    upload: async () => (calls.push('upload'), down),
  }
  const again = restart(l.mac, { gitEnv: { ...l.w.env, PATH: '/nonexistent' }, peers: peers as unknown as TestHost['host']['peers'] })
  await again.atStart()
  assert.equal((await readJournal(l.mac.host.paths, hid, 'vault'))?.phase, 'pending-peer')
  assert.deepEqual(calls, [])
})

// ---------------------------------------------------------------------------
// J14b — the target's rows
// ---------------------------------------------------------------------------

async function targetJournal(l: Linked, phase: Journal['phase'], over: Partial<Journal> = {}): Promise<string> {
  const hid = uuidv7(Date.now())
  await writeJournal(l.omarchy.host.paths, { ...newJournal({ hid, siteId: 'obsidian', role: 'target', peer: 'juans-macbook-pro', phase, at: new Date().toISOString() }), ...over })
  await l.omarchy.host.locks.acquire('obsidian', `handoff-${hid}`, 'x')
  return hid
}

test('preparing at a restart: let go, aborted', async () => {
  const { l } = await scene()
  const hid = await targetJournal(l, 'preparing')
  await restart(l.omarchy).atStart()
  assert.equal((await readJournal(l.omarchy.host.paths, hid, 'obsidian'))?.phase, 'aborted')
  assert.deepEqual(await holders(l.omarchy, 'obsidian'), [])
})

test('committed with its holder still on (the daemon fell between the two): let go', async () => {
  const { l } = await scene()
  const hid = await targetJournal(l, 'committed')
  await restart(l.omarchy).atStart()
  assert.equal((await readJournal(l.omarchy.host.paths, hid, 'obsidian'))?.phase, 'committed')
  assert.deepEqual(await holders(l.omarchy, 'obsidian'), [])
})

test('abort-failed at a restart: only the holder goes; nothing else is touched', async () => {
  const { l } = await scene()
  const replaced = join(l.omarchy.host.paths.root, 'handoff')
  const hid = await targetJournal(l, 'abort-failed', { leftovers: [{ step: 'restoreSession' }] })
  await mkdir(join(replaced, hid, 'obsidian', 'replaced', 'x'), { recursive: true })
  await restart(l.omarchy).atStart()
  assert.deepEqual(await holders(l.omarchy, 'obsidian'), [])
  assert.equal((await readJournal(l.omarchy.host.paths, hid, 'obsidian'))?.phase, 'abort-failed')
  assert.equal(await there(join(replaced, hid, 'obsidian', 'replaced', 'x')), true)
})

test('prepared at a restart: the TTL is armed for what is LEFT of it, from lastSignalAt (criterion 30b)', async () => {
  const { l } = await scene()
  const timers = manualTimers()
  const hid = await targetJournal(l, 'prepared', { lastSignalAt: new Date(Date.now() - 10 * 60_000).toISOString() })
  const again = restart(l.omarchy, { timers })
  await again.atStart()
  await timers.advance(4 * 60_000)
  assert.equal((await readJournal(l.omarchy.host.paths, hid, 'obsidian'))?.phase, 'prepared')
  await timers.advance(2 * 60_000)
  for (let i = 0; i < 200 && (await readJournal(l.omarchy.host.paths, hid, 'obsidian'))?.phase !== 'aborted'; i += 1) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal((await readJournal(l.omarchy.host.paths, hid, 'obsidian'))?.phase, 'aborted')
  assert.deepEqual(await holders(l.omarchy, 'obsidian'), [])
})

test('prepared whose TTL ran out while the daemon was down: staging gone, aborted, let go — in moment 1', async () => {
  const { l } = await scene()
  const hid = await targetJournal(l, 'prepared', { lastSignalAt: new Date(Date.now() - 20 * 60_000).toISOString() })
  const staging = join(l.omarchy.host.paths.handoffWork(hid, 'obsidian'), 'staging')
  await mkdir(staging, { recursive: true })
  await writeFile(join(staging, 'code.bundle'), 'x')
  await restart(l.omarchy).atStart()
  assert.equal((await readJournal(l.omarchy.host.paths, hid, 'obsidian'))?.phase, 'aborted')
  assert.equal(await there(staging), false)
})

for (const cut of ['before the session moves', 'after the session moved, before its event'] as const) {
  test(`INSTALLING CUT ${cut.toUpperCase()}: after the restart it is undone from the journal, and the target is as it was (criterion 32)`, async () => {
    const { l, session } = await scene()
    const before = {
      head: await sh(l.w.env, l.w.target, 'rev-parse', 'HEAD'),
      status: await sh(l.w.env, l.w.target, 'status', '--porcelain'),
    }
    // The target's daemon "dies" inside the install: its store stops answering at that step.
    const store = l.omarchy.host.store
    const hang = new Proxy(store, {
      get: (target, key) => {
        if (cut === 'before the session moves' && key === 'importSession') return never
        if (cut === 'after the session moved, before its event' && key === 'append') return never
        const value = Reflect.get(target, key) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as SessionStore
    const dying = createHandoff({ ...l.omarchy.host, store: hang }, FAST)
    l.toOmarchy.route = apiRoute(dying, l.omarchy.home)
    const next = l.toOmarchy.route
    let reached = () => undefined as void
    const atCommit = new Promise<void>((resolve) => (reached = resolve))
    l.toOmarchy.route = async (method, path, body, file) => {
      if (path.endsWith('/commit')) {
        reached()
        void next(method, path, body, file)
        return await never()
      }
      return await next(method, path, body, file)
    }
    const started = await l.mac.api.start({ to: 'omarchy' })
    const hid = started.kind === 'ok' ? (started.body as { hid: string }).hid : ''
    await atCommit
    // Wait until the commit reaches the hung step.
    for (let i = 0; i < 400 && (await readJournal(l.omarchy.host.paths, hid, 'obsidian'))?.installed.every((e) => e.kind !== 'session') !== false; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal((await readJournal(l.omarchy.host.paths, hid, 'obsidian'))?.phase, 'installing')

    const again = restart(l.omarchy)
    await again.atStart()
    await again.afterStart()
    const journal = await readJournal(l.omarchy.host.paths, hid, 'obsidian')
    assert.equal(journal?.phase, 'aborted')
    assert.deepEqual(await holders(l.omarchy, 'obsidian'), [])
    assert.equal(await sh(l.w.env, l.w.target, 'rev-parse', 'HEAD'), before.head)
    assert.equal(await sh(l.w.env, l.w.target, 'status', '--porcelain'), before.status)
    assert.equal(await l.omarchy.host.store.readMeta(session.id), undefined)
  })
}
