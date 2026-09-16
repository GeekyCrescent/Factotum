import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { MAX_BODY_BYTES } from '@factotum/core'
import { createServer } from './server.ts'
import { createStaticSite } from './static.ts'
import { policyFor } from '../net/policy.ts'
import { Registry } from '../modules/registry.ts'
import { statePaths } from '../config/paths.ts'
import type { PushService, SubscribeResult } from '../push/service.ts'

const PUBLIC = 'https://mimac.tail1234.ts.net'
const FOREIGN = 'https://evil.example'
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/SECRET-CAPABILITY'

const subscription = {
  endpoint: ENDPOINT,
  expirationTime: null,
  keys: { p256dh: 'B' + 'x'.repeat(86), auth: 'y'.repeat(22) },
}

type FakePush = Pick<PushService, 'publicKey' | 'subscribe'>

// NOT a default parameter for the key: passing `undefined` to one ACTIVATES the default, which is
// how the push-off test first passed a key it meant to withhold.
const onPush = (result: SubscribeResult = { kind: 'subscribed', count: 1 }, key: { readonly publicKey: string | undefined } = { publicKey: 'B'.repeat(87) }): FakePush => ({
  publicKey: () => key.publicKey,
  subscribe: async () => result,
})

async function start(opts: { push?: FakePush; ready?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'factotum-site-'))
  await writeFile(join(root, 'index.html'), '<!doctype html><title>factotum</title>')
  const home = await mkdtemp(join(tmpdir(), 'factotum-home-'))
  const registry = await Registry.create([], {
    paths: statePaths('prod', home),
    env: 'prod',
    push: { canReach: () => false, send: async () => undefined },
  })

  const server = createServer({
    registry,
    origin: policyFor({ publicOrigin: PUBLIC, address: '127.0.0.1', port: 7777, extraOrigins: [] }),
    env: 'prod',
    version: 'test',
    startedAt: Date.now(),
    site: createStaticSite(root),
    push: opts.push ?? onPush(),
    isReady: () => opts.ready ?? true,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

// ---------------------------------------------------------------------------
// §0.25 — the static fallback used to swallow every GET under /push
// ---------------------------------------------------------------------------

test('A FOREIGN ORIGIN GETS 403 ON GET /push/public-key, NOT 200 text/html (criterion 9)', async () => {
  // THE test for the hole the first audit found. The static branch runs before the origin check
  // and falls back to index.html, so without the exclusion this answered 200 HTML — unreachable
  // and above the 403. A test that only exercised the POST would pass with the hole open: the
  // static branch only takes GETs.
  const { base, close } = await start()
  try {
    const response = await fetch(`${base}/push/public-key`, { headers: { origin: FOREIGN } })
    assert.equal(response.status, 403)
    assert.match(response.headers.get('content-type') ?? '', /json/)
  } finally {
    await close()
  }
})

test('the SPA fallback still works for what it is for — and not for /push (criterion 43)', async () => {
  // Both in one test: the only way to show the exclusion is surgical rather than a new hole.
  const { base, close } = await start()
  try {
    const deep = await fetch(`${base}/m/probe/019a-some-id`)
    assert.equal(deep.status, 200)
    assert.match(await deep.text(), /<title>factotum/)

    const key = await fetch(`${base}/push/public-key`)
    assert.doesNotMatch(await key.text(), /<title>/)
  } finally {
    await close()
  }
})

test('the exclusion is the /push prefix exactly: /pushup is still the client’s', async () => {
  const { base, close } = await start()
  try {
    const response = await fetch(`${base}/pushup`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /<title>factotum/)
  } finally {
    await close()
  }
})

test('the accepted origin, and a request with no Origin at all, get the public key', async () => {
  const { base, close } = await start()
  try {
    for (const headers of [{ origin: PUBLIC }, {}]) {
      const response = await fetch(`${base}/push/public-key`, { headers })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { publicKey: 'B'.repeat(87) })
    }
  } finally {
    await close()
  }
})

test('both push routes answer 503 before READY (criterion 9)', async () => {
  const { base, close } = await start({ ready: false })
  try {
    assert.equal((await fetch(`${base}/push/public-key`)).status, 503)
    const post = await fetch(`${base}/push/subscriptions`, { method: 'POST', body: JSON.stringify(subscription) })
    assert.equal(post.status, 503)
  } finally {
    await close()
  }
})

test('a foreign origin is refused on the POST too', async () => {
  let called = 0
  const { base, close } = await start({ push: { ...onPush(), subscribe: async () => (called++, { kind: 'subscribed', count: 1 }) } })
  try {
    const response = await fetch(`${base}/push/subscriptions`, {
      method: 'POST',
      headers: { origin: FOREIGN },
      body: JSON.stringify(subscription),
    })
    assert.equal(response.status, 403)
    assert.equal(called, 0)
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// POST /push/subscriptions
// ---------------------------------------------------------------------------

test('a valid subscription answers the COUNT, and nothing in the answer is an endpoint (criteria 10, 54)', async () => {
  const { base, close } = await start({ push: onPush({ kind: 'subscribed', count: 2 }) })
  try {
    const response = await fetch(`${base}/push/subscriptions`, { method: 'POST', body: JSON.stringify(subscription) })
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(text), { count: 2 })
    assert.doesNotMatch(text, /SECRET-CAPABILITY/)
  } finally {
    await close()
  }
})

test('an invalid body is a 400 that names the field', async () => {
  const { base, close } = await start()
  try {
    const response = await fetch(`${base}/push/subscriptions`, {
      method: 'POST',
      body: JSON.stringify({ ...subscription, endpoint: 'http://plain.example/x' }),
    })
    assert.equal(response.status, 400)
    assert.match(JSON.stringify(await response.json()), /endpoint/)
  } finally {
    await close()
  }
})

test('the cap answers 409 conflict, and the message names the way out (criteria 54, 57)', async () => {
  const reason = 'this machine already has 5 subscribed devices… run `factotum push reset`'
  const { base, close } = await start({ push: onPush({ kind: 'full', count: 5, reason }) })
  try {
    const response = await fetch(`${base}/push/subscriptions`, { method: 'POST', body: JSON.stringify(subscription) })
    const body = (await response.json()) as { error: { code: string; message: string } }
    assert.equal(response.status, 409)
    assert.equal(body.error.code, 'conflict')
    assert.match(body.error.message, /factotum push reset/)
  } finally {
    await close()
  }
})

test('the body cap is the SAME 413 as for modules — one helper, not a copy', async () => {
  const { base, close } = await start()
  try {
    const response = await fetch(`${base}/push/subscriptions`, { method: 'POST', body: 'x'.repeat(MAX_BODY_BYTES + 1) })
    assert.equal(response.status, 413)
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'body-too-large')
  } finally {
    await close()
  }
})

test('non-JSON is a 400, through the same helper', async () => {
  const { base, close } = await start()
  try {
    const response = await fetch(`${base}/push/subscriptions`, { method: 'POST', body: '{nope' })
    assert.equal(response.status, 400)
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// Push off, and what never leaves
// ---------------------------------------------------------------------------

test('push off answers 404 on both routes, and the message carries no path', async () => {
  const reason = 'push is off: /Users/someone/.factotum/prod/push/keys.json is unusable'
  const { base, close } = await start({ push: onPush({ kind: 'off', reason }, { publicKey: undefined }) })
  try {
    const key = await fetch(`${base}/push/public-key`)
    const post = await fetch(`${base}/push/subscriptions`, { method: 'POST', body: JSON.stringify(subscription) })
    for (const response of [key, post]) {
      const text = await response.text()
      assert.equal(response.status, 404)
      assert.doesNotMatch(text, /\/Users\/|keys\.json/)
      assert.match(text, /factotum doctor/)
    }
  } finally {
    await close()
  }
})

test('an unknown verb or path under /push is a 404, not the SPA', async () => {
  const { base, close } = await start()
  try {
    assert.equal((await fetch(`${base}/push/subscriptions`)).status, 404)
    assert.equal((await fetch(`${base}/push/other`)).status, 404)
  } finally {
    await close()
  }
})

test('/health and /modules never carry subscription data (criterion 10)', async () => {
  const { base, close } = await start()
  try {
    await fetch(`${base}/push/subscriptions`, { method: 'POST', body: JSON.stringify(subscription) })
    for (const path of ['/health', '/modules']) {
      assert.doesNotMatch(await (await fetch(`${base}${path}`)).text(), /SECRET-CAPABILITY|fcm\.googleapis|p256dh/)
    }
  } finally {
    await close()
  }
})
