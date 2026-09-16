import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { Logger, PushEnvelope } from '@factotum/core'
import { SubscriptionStore, type Subscription } from './store.ts'
import { MAX_PLAINTEXT_BYTES, defaultDeliver, sendToAll, type Deliver } from './send.ts'
import type { VapidKeys } from './keys.ts'

// A real pair: the default deliver signs with it, so it has to be one.
import webpush from 'web-push'
const keys: VapidKeys = (() => {
  const k = webpush.generateVAPIDKeys()
  return { publicKey: k.publicKey, privateKey: k.privateKey }
})()

const envelope: PushEnvelope = {
  message: { title: 'fin', body: 'proyecto-a · finished', path: '/m/sessions/x', tag: 'x' },
  moduleId: 'sessions',
  machine: 'mimac',
}

const sub = (name: string): Subscription => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/SECRET-CAPABILITY-${name}`,
  keys: { p256dh: 'BPp', auth: 'au' },
})

function recordingLog(): Logger & { readonly lines: string[] } {
  const lines: string[] = []
  const push = (m: string) => void lines.push(m)
  return { lines, info: push, warn: push, error: push }
}

async function storeWith(...names: string[]): Promise<SubscriptionStore> {
  const { store } = await SubscriptionStore.open(await mkdtemp(join(tmpdir(), 'factotum-send-')))
  for (const n of names) await store.upsert(sub(n))
  return store
}

/** A deliver that answers by endpoint suffix. */
const answering = (codes: Record<string, number>): Deliver => async (s) => {
  const name = s.endpoint.split('-').pop() ?? ''
  return { statusCode: codes[name] ?? 201 }
}

test('every subscription is delivered to, and the report counts them', async () => {
  const store = await storeWith('a', 'b')
  const report = await sendToAll(envelope, { keys, store, log: recordingLog(), subject: 'https://mimac.example', deliver: answering({}) })

  assert.deepEqual(report, { delivered: 2, removed: 0, failed: 0, skipped: undefined })
})

test('THE TEST THAT CATCHES Promise.all: the first subscription is dead, the second still receives (criterion 7)', async () => {
  const store = await storeWith('dead', 'alive')
  const reached: string[] = []
  const deliver: Deliver = async (s) => {
    reached.push(s.endpoint)
    if (s.endpoint.endsWith('dead')) throw new Error('boom')
    return { statusCode: 201 }
  }

  const report = await sendToAll(envelope, { keys, store, log: recordingLog(), subject: 'https://m', deliver })

  assert.equal(reached.length, 2)
  assert.equal(report.delivered, 1)
  assert.equal(report.failed, 1)
})

test('410 and 404 unsubscribe — and the removal is on disk, not just in memory (spec A6)', async () => {
  const store = await storeWith('gone', 'missing', 'fine')
  const report = await sendToAll(envelope, {
    keys, store, log: recordingLog(), subject: 'https://m', deliver: answering({ gone: 410, missing: 404 }),
  })

  assert.equal(report.removed, 2)
  assert.deepEqual(store.all().map((s) => s.endpoint.split('-').pop()), ['fine'])
})

test('403 does NOT unsubscribe: it means OUR keys are wrong, and removing would wipe every device (spec A6)', async () => {
  // Measured against FCM: a mismatched VAPID pair answers 403 to every subscription, and the
  // same subscription answers 201 again with the right pair. Treating 403 as "dead" turns a key
  // problem into silently losing every phone.
  const store = await storeWith('a', 'b')
  const log = recordingLog()

  const report = await sendToAll(envelope, { keys, store, log, subject: 'https://m', deliver: answering({ a: 403, b: 403 }) })

  assert.equal(store.count(), 2)
  assert.equal(report.removed, 0)
  const vapidWarnings = log.lines.filter((l) => /VAPID/.test(l))
  assert.equal(vapidWarnings.length, 1, 'one loud line per send, not one per device')
})

test('400, 413, 429 and 5xx keep the subscription: none of them says the device is gone', async () => {
  const store = await storeWith('a', 'b', 'c', 'd')
  await sendToAll(envelope, { keys, store, log: recordingLog(), subject: 'https://m', deliver: answering({ a: 400, b: 413, c: 429, d: 503 }) })
  assert.equal(store.count(), 4)
})

test('a deliver that NEVER answers is aborted by its signal, and send resolves (criterion 8)', async () => {
  const store = await storeWith('hang')
  const deliver: Deliver = (_s, _p, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))

  const started = Date.now()
  const report = await sendToAll(envelope, { keys, store, log: recordingLog(), subject: 'https://m', deliver, timeoutMs: 50 })

  assert.equal(report.failed, 1)
  assert.ok(Date.now() - started < 1000, 'bounded by the signal, not by the test runner')
})

test('send never rejects — not even when removing a dead subscription fails', async () => {
  const store = await storeWith('gone')
  ;(store as unknown as { remove: () => Promise<boolean> }).remove = async () => {
    throw new Error('EACCES')
  }

  const report = await sendToAll(envelope, { keys, store, log: recordingLog(), subject: 'https://m', deliver: answering({ gone: 410 }) })
  assert.equal(report.removed, 0)
})

test('a payload over the push-service limit is never sent (spec A5: 3993 bytes in clear)', async () => {
  const store = await storeWith('a')
  let called = 0
  const huge: PushEnvelope = { ...envelope, message: { ...envelope.message, body: 'x'.repeat(MAX_PLAINTEXT_BYTES) } }

  const report = await sendToAll(huge, { keys, store, log: recordingLog(), subject: 'https://m', deliver: async () => (called++, { statusCode: 201 }) })

  assert.equal(called, 0, 'FCM answers 400 above the limit; sending would only earn that')
  assert.match(report.skipped ?? '', /bytes/)
})

test('the limit is counted in UTF-8 BYTES, not characters', async () => {
  // Three bytes per character: under the limit by length, over it by bytes.
  const store = await storeWith('a')
  let called = 0
  const wide: PushEnvelope = { ...envelope, message: { ...envelope.message, body: '€'.repeat(1400) } }

  await sendToAll(wide, { keys, store, log: recordingLog(), subject: 'https://m', deliver: async () => (called++, { statusCode: 201 }) })
  assert.equal(called, 0)
})

test('no log line ever carries an endpoint — they are capabilities', async () => {
  const store = await storeWith('gone', 'forbidden', 'broken', 'hang')
  const log = recordingLog()
  const deliver: Deliver = async (s, _p, { signal }) => {
    if (s.endpoint.endsWith('gone')) return { statusCode: 410 }
    if (s.endpoint.endsWith('forbidden')) return { statusCode: 403 }
    if (s.endpoint.endsWith('broken')) throw new Error(`connect ECONNREFUSED ${s.endpoint}`)
    return await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  }

  await sendToAll(envelope, { keys, store, log, subject: 'https://m', deliver, timeoutMs: 30 })

  assert.ok(log.lines.length > 0)
  for (const line of log.lines) assert.doesNotMatch(line, /SECRET-CAPABILITY/, `leaked: ${line}`)
})

test('criterion 56 — the REAL adapter aborts against a server that never answers', async () => {
  // Every test above uses a double, so none of them proves the library honours the deadline.
  // This one uses the default deliver: web-push only builds the encrypted request, and fetch
  // sends it with the signal. (Measured in spec A7: web-push's own `timeout` is an idle-socket
  // timeout and a server that trickles a byte a second keeps it waiting for ever.)
  const mute = createServer((req) => void req.resume())
  await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', resolve))
  const { port } = mute.address() as { port: number }

  // A cryptographically valid subscription: web-push checks the point is on the curve.
  const { createECDH, randomBytes } = await import('node:crypto')
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const target: Subscription = {
    endpoint: `http://127.0.0.1:${port}/push`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  }

  const deliver = defaultDeliver({ keys, subject: 'https://mimac.example' })
  const started = Date.now()
  try {
    await assert.rejects(deliver(target, '{}', { signal: AbortSignal.timeout(200) }), { name: 'TimeoutError' })
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 180 && elapsed < 2000, `aborted at ${elapsed}ms`)
  } finally {
    mute.closeAllConnections()
    mute.close()
  }
})
