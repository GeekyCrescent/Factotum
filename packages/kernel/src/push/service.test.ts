import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger, NotificationMessage, PushEnvelope } from '@factotum/core'
import { MAX_SUBSCRIPTIONS, createPushService } from './service.ts'
import type { Deliver } from './send.ts'
import type { Subscription } from './store.ts'
import type { VapidKeys } from './keys.ts'

const FAKE_KEYS: VapidKeys = { publicKey: 'B'.repeat(87), privateKey: 'p'.repeat(43) }
const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
const message: NotificationMessage = { title: 'finished', body: 'proyecto-a', path: '/m/sessions/x', tag: 'x' }

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
  await push.subscribe(device('phone'))

  assert.equal(push.canReach(), true)
  await push.send(message, 'sessions')
  assert.equal(sent.length, 1)
})

test('the kernel stamps machine and moduleId; the module cannot', async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })
  await push.subscribe(device('phone'))

  await push.send(message, 'sessions')

  assert.deepEqual(sent[0]?.envelope, { message, moduleId: 'sessions', machine: 'mimac' })
})

test('the FIRST device on a fresh daemon is not announced — there is nobody to tell — but the count says so (criterion 54)', async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })

  const result = await push.subscribe(device('first'))

  assert.deepEqual(result, { kind: 'subscribed', count: 1 })
  assert.equal(sent.length, 0)
})

test('a NEW device is announced to the devices that existed before it, and NOT to itself (criterion 53)', async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })
  await push.subscribe(device('owner'))

  const result = await push.subscribe(device('intruder'))
  await push.settled()

  assert.deepEqual(result, { kind: 'subscribed', count: 2 })
  assert.deepEqual(sent.map((s) => s.to), ['owner'], 'the newcomer must not learn it was noticed')
})

test('the announcement is the daemon speaking: moduleId null, the remedy named, no endpoint (criteria 53, 59)', async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })
  await push.subscribe(device('owner'))
  await push.subscribe(device('second'))
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
  await push.subscribe(device('owner'))
  await push.subscribe(device('tablet'))
  await push.settled()
  sent.length = 0

  const result = await push.subscribe(device('tablet'))
  await push.settled()

  assert.deepEqual(result, { kind: 'subscribed', count: 2 })
  assert.equal(sent.length, 0)
})

test('a NEW device past the cap is refused, not stored, not announced — and the reason names the way out (criteria 54, 57)', async () => {
  const { deliver, sent } = recorder()
  const push = await service({ deliver })
  for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) await push.subscribe(device(`d${i}`))
  await push.settled()
  sent.length = 0

  const result = await push.subscribe(device('one-too-many'))

  assert.equal(result.kind, 'full')
  assert.match(result.kind === 'full' ? result.reason : '', /factotum push reset/)
  assert.equal(push.count(), MAX_SUBSCRIPTIONS)
  assert.equal(sent.length, 0)
})

test('a KNOWN device can still re-subscribe when the cap is full', async () => {
  const push = await service({ deliver: recorder().deliver })
  for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) await push.subscribe(device(`d${i}`))

  const result = await push.subscribe(device('d0'))
  assert.equal(result.kind, 'subscribed')
})

test('reset empties everything, and the gate falls back to denying (criterion 57)', async () => {
  const push = await service({ deliver: recorder().deliver })
  await push.subscribe(device('a'))
  await push.subscribe(device('b'))

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
  await push.send(message, 'sessions') // must resolve
  const result = await push.subscribe(device('phone'))
  assert.equal(result.kind, 'off')
})

test('send never rejects, whatever deliver does', async () => {
  const push = await service({ deliver: async () => { throw new Error('boom') } })
  await push.subscribe(device('phone'))
  await push.send(message, 'sessions')
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
  await push.subscribe(device('phone'))
  await push.subscribe(device('tablet'))
  await push.settled()

  const inspection = await inspectPush(dir)

  assert.deepEqual(inspection, { kind: 'ready', subscriptions: 2, warning: undefined })
  assert.doesNotMatch(JSON.stringify(inspection), /device-|BBBB|pppp/)
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
  for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) await push.subscribe(device(`d${i}`))
  await push.settled()

  assert.equal(await resetSubscriptions(dir), MAX_SUBSCRIPTIONS)
  assert.deepEqual(await inspectPush(dir), { kind: 'ready', subscriptions: 0, warning: undefined })

  // …and a fresh daemon on that directory accepts a legitimate device again.
  const fresh = await service({ dir, deliver: recorder().deliver })
  assert.equal((await fresh.subscribe(device('mine'))).kind, 'subscribed')
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
  await push.subscribe(device('phone'))

  void push.send(message, 'sessions')
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
