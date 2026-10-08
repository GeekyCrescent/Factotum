import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger, NotificationMessage, PushEnvelope } from '@factotum/core'
import { MAX_SUBSCRIPTIONS, createPushService } from './service.ts'
import type { Deliver } from './send.ts'
import type { Subscription } from './store.ts'
import type { VapidKeys } from './keys.ts'
import { PUSH_RELAY_TIMEOUT_MS } from './relay.ts'
import { timerSet } from '../modules/registry.ts'
import type { PeerState } from '../net/peers.ts'

const FAKE_KEYS: VapidKeys = { publicKey: 'B'.repeat(87), privateKey: 'p'.repeat(43) }
/** Every device in these tests is a phone: the kernel read the request as not this machine. */
const PHONE = { sameMachine: false } as const
const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
const message: NotificationMessage = { title: 'finished', body: 'proyecto-a', path: '/m/probe/x', tag: 'x' }

const device = (name: string): Subscription => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/device-${name}`,
  keys: { p256dh: 'BPp', auth: 'au' },
})

interface Sent {
  readonly to: string
  readonly envelope: PushEnvelope
}

function recorder(): { deliver: Deliver; sent: Sent[] } {
  const sent: Sent[] = []
  const deliver: Deliver = async (s, payload) => {
    sent.push({ to: s.endpoint.split('-').pop() ?? '', envelope: JSON.parse(payload) as PushEnvelope })
    return { statusCode: 201 }
  }
  return { deliver, sent }
}

async function service(extra: { deliver?: Deliver; dir?: string } = {}) {
  const dir = extra.dir ?? (await mkdtemp(join(tmpdir(), 'factotum-svc-')))
  return await createPushService({
    dir,
    machine: 'mimac',
    subject: 'https://mimac.example',
    log: quiet,
    generate: () => FAKE_KEYS,
    ...(extra.deliver !== undefined ? { deliver: extra.deliver } : {}),
  })
}

test('with no subscriptions, canReach is false — and it answers SYNCHRONOUSLY', async () => {
  // It is asked by the permission gate before deciding whether it may ask at all. A promise
  // here would force I/O into the one path that must not do any (spec D1).
  const push = await service()
  const answer = push.canReach()
  assert.equal(typeof answer, 'boolean')
  assert.equal(answer, false)
})

test('once a device subscribes, canReach is true and a send reaches it', async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })
  await push.subscribe(device('phone'), PHONE)

  assert.equal(push.canReach(), true)
  await push.send(message, 'probe')
  assert.equal(sent.length, 1)
})

test('the kernel stamps machine and moduleId; the module cannot', async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })
  await push.subscribe(device('phone'), PHONE)

  await push.send(message, 'probe')

  assert.deepEqual(sent[0]?.envelope, { message, moduleId: 'probe', machine: 'mimac' })
})

test('the FIRST device on a fresh daemon is not announced — there is nobody to tell — but the count says so (criterion 54)', async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })

  const result = await push.subscribe(device('first'), PHONE)

  assert.deepEqual(result, { kind: 'subscribed', count: 1 })
  assert.equal(sent.length, 0)
})

test('a NEW device is announced to the devices that existed before it, and NOT to itself (criterion 53)', async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })
  await push.subscribe(device('owner'), PHONE)

  const result = await push.subscribe(device('intruder'), PHONE)
  await push.settled()

  assert.deepEqual(result, { kind: 'subscribed', count: 2 })
  assert.deepEqual(sent.map((s) => s.to), ['owner'], 'the newcomer must not learn it was noticed')
})

test('the announcement is the daemon speaking: moduleId null, the remedy named, no endpoint (criteria 53, 59)', async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })
  await push.subscribe(device('owner'), PHONE)
  await push.subscribe(device('second'), PHONE)
  await push.settled()

  const notice = sent[0]?.envelope
  assert.equal(notice?.moduleId, null)
  assert.equal(notice?.message.path, '/')
  assert.match(notice?.message.body ?? '', /factotum push reset/)
  assert.match(notice?.message.body ?? '', /2/)
  assert.doesNotMatch(JSON.stringify(notice), /device-/)
})

test('re-subscribing a KNOWN device is an update: not announced, not counted twice', async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })
  await push.subscribe(device('owner'), PHONE)
  await push.subscribe(device('tablet'), PHONE)
  await push.settled()
  sent.length = 0

  const result = await push.subscribe(device('tablet'), PHONE)
  await push.settled()

  assert.deepEqual(result, { kind: 'subscribed', count: 2 })
  assert.equal(sent.length, 0)
})

test('a NEW device past the cap is refused, not stored, not announced — and the reason names the way out (criteria 54, 57)', async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })
  for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) await push.subscribe(device(`d${i}`), PHONE)
  await push.settled()
  sent.length = 0

  const result = await push.subscribe(device('one-too-many'), PHONE)

  assert.equal(result.kind, 'full')
  assert.match(result.kind === 'full' ? result.reason : '', /factotum push reset/)
  assert.equal(push.count(), MAX_SUBSCRIPTIONS)
  assert.equal(sent.length, 0)
})

test('a KNOWN device can still re-subscribe when the cap is full', async () => {
  const push = await service({ deliver: recorder().deliver })
  for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) await push.subscribe(device(`d${i}`), PHONE)

  const result = await push.subscribe(device('d0'), PHONE)
  assert.equal(result.kind, 'subscribed')
})

test('reset empties everything, and the gate falls back to denying (criterion 57)', async () => {
  const push = await service({ deliver: recorder().deliver })
  await push.subscribe(device('a'), PHONE)
  await push.subscribe(device('b'), PHONE)

  await push.reset()

  assert.equal(push.count(), 0)
  assert.equal(push.canReach(), false)
})

test('NO KEYS: push is off, nothing throws, and the reason is available for doctor (criterion 5)', async () => {
  const push = await createPushService({
    dir: '/nonexistent/factotum/push',
    machine: 'mimac',
    subject: 'https://m',
    log: quiet,
  })

  assert.equal(push.canReach(), false)
  assert.equal(push.publicKey(), undefined)
  assert.equal(push.status().kind, 'off')
  await push.send(message, 'probe') // must resolve
  const result = await push.subscribe(device('phone'), PHONE)
  assert.equal(result.kind, 'off')
})

test('send never rejects, whatever deliver does', async () => {
  const push = await service({ deliver: async () => { throw new Error('boom') } })
  await push.subscribe(device('phone'), PHONE)
  await push.send(message, 'probe')
})

test('the public key is exposed; the private one has no accessor at all', async () => {
  const push = await service()
  assert.equal(push.publicKey(), FAKE_KEYS.publicKey)
  assert.equal(JSON.stringify(push).includes(FAKE_KEYS.privateKey), false)
  assert.equal(Object.values(push).some((v) => typeof v === 'string' && v === FAKE_KEYS.privateKey), false)
})

test('keys survive a restart: the same directory gives the same public key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'factotum-svc-'))
  const first = await service({ dir })
  const second = await createPushService({ dir, machine: 'mimac', subject: 'https://m', log: quiet, generate: () => { throw new Error('must not regenerate') } })
  assert.equal(second.publicKey(), first.publicKey())
})

// ---------------------------------------------------------------------------
// inspectPush and resetSubscriptions — for doctor and `factotum push reset`
// ---------------------------------------------------------------------------

test('inspectPush NEVER creates anything: a diagnostic must not change what it reports on', async () => {
  const { inspectPush } = await import('./service.ts')
  const { readdir } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'factotum-inspect-'))

  assert.deepEqual(await inspectPush(dir), { kind: 'no-keys' })
  assert.deepEqual(await readdir(dir), [], 'no key file, no subscriptions file')
})

test('inspectPush reports a count and nothing else — no key, no endpoint (criterion 3)', async () => {
  const { inspectPush } = await import('./service.ts')
  const dir = await mkdtemp(join(tmpdir(), 'factotum-inspect-'))
  const push = await service({ dir, deliver: recorder().deliver })
  await push.subscribe(device('phone'), PHONE)
  await push.subscribe(device('tablet'), PHONE)
  await push.settled()

  const inspection = await inspectPush(dir)

  assert.deepEqual(inspection, { kind: 'ready', subscriptions: 2, sameMachine: 0, warning: undefined })
  assert.doesNotMatch(JSON.stringify(inspection), /device-|BBBB|pppp/)
})

test('a subscription remembers whether it came from this machine, and re-posting UPDATES it (design D12)', async () => {
  const { inspectPush } = await import('./service.ts')
  const dir = await mkdtemp(join(tmpdir(), 'factotum-inspect-'))
  const push = await service({ dir, deliver: recorder().deliver })
  await push.subscribe(device('mac'), PHONE)
  await push.subscribe(device('phone'), PHONE)
  await push.settled()
  assert.equal((await inspectPush(dir) as { sameMachine: number }).sameMachine, 0)

  // The client re-posts at start, and this time the kernel can tell.
  await push.subscribe(device('mac'), { sameMachine: true })
  await push.settled()

  const inspection = await inspectPush(dir)
  assert.equal(inspection.kind === 'ready' && inspection.subscriptions, 2, 'the same endpoint, not a new one')
  assert.equal(inspection.kind === 'ready' && inspection.sameMachine, 1)
})

test('inspectPush says why a key file is unusable, without touching it', async () => {
  const { inspectPush } = await import('./service.ts')
  const { writeFile, readFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'factotum-inspect-'))
  await writeFile(join(dir, 'keys.json'), 'garbage', 'utf8')

  const inspection = await inspectPush(dir)

  assert.equal(inspection.kind, 'unusable')
  assert.equal(await readFile(join(dir, 'keys.json'), 'utf8'), 'garbage')
})

test('resetSubscriptions forgets every device and reports how many there were (criterion 57)', async () => {
  const { resetSubscriptions, inspectPush } = await import('./service.ts')
  const dir = await mkdtemp(join(tmpdir(), 'factotum-reset-'))
  const push = await service({ dir, deliver: recorder().deliver })
  for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) await push.subscribe(device(`d${i}`), PHONE)
  await push.settled()

  assert.equal(await resetSubscriptions(dir), MAX_SUBSCRIPTIONS)
  assert.deepEqual(await inspectPush(dir), { kind: 'ready', subscriptions: 0, sameMachine: 0, warning: undefined })

  // …and a fresh daemon on that directory accepts a legitimate device again.
  const fresh = await service({ dir, deliver: recorder().deliver })
  assert.equal((await fresh.subscribe(device('mine'), PHONE)).kind, 'subscribed')
})

test('settled() waits for a notice fired WITHOUT await — what boot.stop relies on to not cut one off', async () => {
  // engine.stop() fires its "cancelled" notices and returns; boot then awaits settled() before
  // closing. If send were not tracked, shutdown would drop the very notice criterion 27 is about.
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  let delivered = false
  const push = await service({
    deliver: async () => {
      await gate
      delivered = true
      return { statusCode: 201 }
    },
  })
  await push.subscribe(device('phone'), PHONE)

  void push.send(message, 'probe')
  let drainedEarly = false
  const drained = push.settled().then(() => void (drainedEarly = !delivered))
  // A real turn of the event loop with the delivery still held. Without tracking, settled() has
  // nothing to wait for and resolves here. (The first version of this test released the gate
  // straight away and passed by microtask ordering, with no tracking at all.)
  await new Promise((resolve) => setTimeout(resolve, 30))
  release()
  await drained

  assert.equal(drainedEarly, false, 'settled() resolved while a notice was still in flight')
  assert.equal(delivered, true)
})

// ---------------------------------------------------------------------------
// relay(envelope) — a notice raised on the peer (spec 2026-10-07, D6, criteria 15 and 16)
// ---------------------------------------------------------------------------

const MAC = 'juans-macbook-pro'
const fromMac = (data: Record<string, unknown> = { host: MAC }): PushEnvelope => ({
  message: { ...message, path: `/h/${MAC}/m/sessions/s1?ask=tok`, data },
  moduleId: 'sessions',
  machine: MAC,
})

/** The title `public/sw.js` paints, composed the way it composes it (`push` handler). */
const titleOf = (envelope: PushEnvelope | undefined): string =>
  envelope?.machine ? `${envelope.machine}: ${envelope.message.title}` : (envelope?.message.title ?? '')

test("relay delivers WITH THE PEER'S MACHINE, so the title is `juans-macbook-pro: …` and not this host's (criterion 15)", async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })
  await push.subscribe(device('phone'), PHONE)

  await push.relay(fromMac())

  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0]?.envelope, fromMac())
  assert.equal(titleOf(sent[0]?.envelope), `${MAC}: finished`)
})

test('relay with no devices of its own does nothing', async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })

  await push.relay(fromMac())
  await push.settled()

  assert.equal(sent.length, 0)
})

test('relay over the cap sends without data, and logs it', async () => {
  const { deliver, sent } = recorder()
  const lines: string[] = []
  const push = await createPushService({
    dir: await mkdtemp(join(tmpdir(), 'factotum-svc-')),
    machine: 'omarchy',
    subject: 'https://omarchy.example',
    log: { ...quiet, warn: (line) => void lines.push(line) },
    generate: () => FAKE_KEYS,
    deliver,
  })
  await push.subscribe(device('phone'), PHONE)

  await push.relay(fromMac({ host: MAC, note: 'x'.repeat(4000) }))

  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.envelope.message.data, undefined)
  assert.equal(sent[0]?.envelope.machine, MAC)
  assert.match(lines.join('\n'), /without its data/)
})

test('relay is tracked: settled() waits for it, as for a send', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  let delivered = false
  const push = await service({
    deliver: async () => {
      await gate
      delivered = true
      return { statusCode: 201 }
    },
  })
  await push.subscribe(device('phone'), PHONE)

  void push.relay(fromMac())
  const drained = push.settled().then(() => delivered)
  await new Promise((resolve) => setTimeout(resolve, 30))
  release()

  assert.equal(await drained, true)
})

test('push off: relay resolves and delivers nothing', async () => {
  const push = await createPushService({ dir: '/nonexistent/factotum/push', machine: 'omarchy', subject: 'https://o', log: quiet })
  await push.relay(fromMac())
})

// ---------------------------------------------------------------------------
// send() forwards to the peer, and canReach() counts its devices (spec 2026-10-07, D6, criterion 17)
//
// The peer is a real server on loopback: what is checked is what goes over the wire — the URL, the
// body, and the absence of `Origin`.
// ---------------------------------------------------------------------------

interface Posted {
  readonly url: string
  readonly origin: string | undefined
  readonly type: string | undefined
  readonly body: PushEnvelope
}

/** A peer daemon's `/push/relay`, recording what it receives. `hold` keeps it from answering. */
async function relayPeer(opts: { status?: number; hold?: boolean } = {}) {
  const posted: Posted[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      posted.push({
        url: req.url ?? '',
        origin: req.headers.origin,
        type: req.headers['content-type'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as PushEnvelope,
      })
      if (opts.hold !== true) res.writeHead(opts.status ?? 202, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    posted,
    url: new URL(`http://127.0.0.1:${port}/push/relay`),
    close: () => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const peerState = (over: Partial<PeerState> = {}): PeerState => ({
  name: 'omarchy',
  origin: 'https://omarchy.tail1234.ts.net',
  reachable: true,
  lastSeenAt: '2026-10-08T10:00:00.000Z',
  version: '1',
  devices: 1,
  ...over,
})

/** The peer table as the push service reads it: the last probe, and where the relay is. */
function peerTable(state: PeerState, url: URL | undefined) {
  return { list: () => [state], relayUrl: (name: string) => (name === state.name ? url : undefined) }
}

async function forwarding(opts: {
  state?: PeerState
  url?: URL | undefined
  deliver?: Deliver
  dir?: string
  timeoutMs?: number
  log?: Logger
}) {
  const timers = timerSet()
  const push = await createPushService({
    dir: opts.dir ?? (await mkdtemp(join(tmpdir(), 'factotum-svc-'))),
    machine: 'mimac',
    subject: 'https://mimac.example',
    log: opts.log ?? quiet,
    generate: () => FAKE_KEYS,
    ...(opts.deliver !== undefined ? { deliver: opts.deliver } : {}),
    peers: {
      table: peerTable(opts.state ?? peerState(), opts.url),
      timers: timers.timers,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
  })
  return { push, timers }
}

test('the relay timeout is the one design D6 names', () => {
  assert.equal(PUSH_RELAY_TIMEOUT_MS, 5_000)
})

test('WITH 0 DEVICES OF ITS OWN and the peer at 1, send() reaches the peer — the old early return would not', async () => {
  const peer = await relayPeer()
  const { deliver, sent } = recorder()
  const { push } = await forwarding({ url: peer.url, deliver })
  try {
    assert.equal(push.count(), 0)
    await push.send(message, 'probe')

    assert.equal(peer.posted.length, 1)
    assert.equal(peer.posted[0]?.url, '/push/relay')
    assert.deepEqual(peer.posted[0]?.body, { message, moduleId: 'probe', machine: 'mimac' })
    assert.equal(peer.posted[0]?.origin, undefined, 'a daemon never sends Origin: the relay refuses it')
    assert.equal(peer.posted[0]?.type, 'application/json')
    assert.equal(sent.length, 0)
  } finally {
    await peer.close()
  }
})

test('with devices of its own AND a peer with devices, send() goes to both', async () => {
  const peer = await relayPeer()
  const { deliver, sent } = recorder()
  const { push } = await forwarding({ url: peer.url, deliver })
  try {
    await push.subscribe(device('phone'), PHONE)
    await push.send(message, 'probe')

    assert.equal(peer.posted.length, 1)
    assert.equal(sent.length, 1)
  } finally {
    await peer.close()
  }
})

test('the two are independent: a peer that does not answer does not hold the own devices back', async () => {
  const peer = await relayPeer({ hold: true })
  const { deliver, sent } = recorder()
  const { push } = await forwarding({ url: peer.url, deliver, timeoutMs: 200 })
  try {
    await push.subscribe(device('phone'), PHONE)
    void push.send(message, 'probe')
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(sent.length, 1, 'delivered while the peer still has not answered')
    await push.settled()
  } finally {
    await peer.close()
  }
})

test('a peer with no devices, or unreachable at the last probe, is not called', async () => {
  for (const state of [peerState({ devices: 0 }), peerState({ reachable: false })]) {
    const peer = await relayPeer()
    const { push } = await forwarding({ state, url: peer.url })
    try {
      await push.send(message, 'probe')
      await push.settled()
      assert.equal(peer.posted.length, 0, JSON.stringify(state))
    } finally {
      await peer.close()
    }
  }
})

test('a peer that hangs is given up on after the relay timeout, on kernel timers, and settled() covers it', async () => {
  const peer = await relayPeer({ hold: true })
  const lines: string[] = []
  const { push } = await forwarding({ url: peer.url, timeoutMs: 100, log: { ...quiet, warn: (line) => void lines.push(line) } })
  try {
    const started = Date.now()
    void push.send(message, 'probe')
    await push.settled()

    assert.equal(peer.posted.length, 1)
    assert.ok(Date.now() - started < 2_000, 'bounded by the timeout, not by the peer')
    assert.match(lines.join('\n'), /relay to omarchy: no answer within 100ms/)
    assert.doesNotMatch(lines.join('\n'), /finished|proyecto-a|127\.0\.0\.1/, 'no content and no URL in the log')
  } finally {
    await peer.close()
  }
})

test('a peer that refuses is logged with its status, and send still resolves', async () => {
  const peer = await relayPeer({ status: 403 })
  const lines: string[] = []
  const { push } = await forwarding({ url: peer.url, log: { ...quiet, warn: (line) => void lines.push(line) } })
  try {
    await push.send(message, 'probe')
    assert.match(lines.join('\n'), /relay to omarchy answered 403/)
  } finally {
    await peer.close()
  }
})

test('a peer that is not listening: send never rejects', async () => {
  const peer = await relayPeer()
  await peer.close()
  const lines: string[] = []
  const { push } = await forwarding({ url: peer.url, log: { ...quiet, warn: (line) => void lines.push(line) } })

  await push.send(message, 'probe')

  assert.match(lines.join('\n'), /relay to omarchy: no answer$/m)
})

test('a peer whose relay URL cannot be built is not called', async () => {
  const { push } = await forwarding({ url: undefined })
  await push.send(message, 'probe')
  await push.settled()
})

test('relay() NEVER forwards: a relayed notice goes to own devices only, even with a reachable peer', async () => {
  const peer = await relayPeer()
  const { deliver, sent } = recorder()
  const { push } = await forwarding({ url: peer.url, deliver })
  try {
    await push.subscribe(device('phone'), PHONE)
    await push.relay(fromMac())
    await push.settled()

    assert.equal(sent.length, 1)
    assert.equal(peer.posted.length, 0)
  } finally {
    await peer.close()
  }
})

test('canReach: no devices here and the peer at 1 → true (criterion 17)', async () => {
  const { push } = await forwarding({ url: undefined })
  assert.equal(push.canReach(), true)
})

test('canReach: no devices here and the peer down, or at 0 → false, and the gate denies at once', async () => {
  for (const state of [peerState({ reachable: false }), peerState({ devices: 0 })]) {
    const { push } = await forwarding({ state, url: undefined })
    assert.equal(push.canReach(), false, JSON.stringify(state))
  }
})

test('canReach reads the LAST probe: the peer going down turns it false with no call', async () => {
  let state = peerState()
  const timers = timerSet()
  const push = await createPushService({
    dir: await mkdtemp(join(tmpdir(), 'factotum-svc-')),
    machine: 'mimac',
    subject: 'https://mimac.example',
    log: quiet,
    generate: () => FAKE_KEYS,
    peers: { table: { list: () => [state], relayUrl: () => undefined }, timers: timers.timers },
  })
  assert.equal(push.canReach(), true)
  state = peerState({ reachable: false })
  assert.equal(push.canReach(), false)
})

test('PUSH OFF HERE still forwards: the relay needs no VAPID keys, and canReach counts the peer', async () => {
  const peer = await relayPeer()
  const timers = timerSet()
  const push = await createPushService({
    dir: '/nonexistent/factotum/push',
    machine: 'mimac',
    subject: 'https://m',
    log: quiet,
    peers: { table: peerTable(peerState(), peer.url), timers: timers.timers },
  })
  try {
    assert.equal(push.status().kind, 'off')
    assert.equal(push.canReach(), true)
    await push.send(message, 'probe')
    await push.settled()
    assert.equal(peer.posted.length, 1)
    assert.equal(peer.posted[0]?.body.machine, 'mimac')
  } finally {
    await peer.close()
  }
})
