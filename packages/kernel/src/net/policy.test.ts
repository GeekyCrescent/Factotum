import { test } from 'node:test'
import assert from 'node:assert/strict'
import { policyFor } from './policy.ts'
import { originAllowed } from './origin.ts'

const PUBLIC = 'https://mimac.tail1234.ts.net'

test('a loopback bind gets a local origin, which is the way in if serve stops', () => {
  const policy = policyFor({
    publicOrigin: PUBLIC,
    address: '127.0.0.1',
    port: 7777,
    extraOrigins: [],
  })
  assert.equal(policy.localOrigin, 'http://127.0.0.1:7777')
  assert.equal(originAllowed('http://127.0.0.1:7777', policy), true)
})

// ---------------------------------------------------------------------------
// Criterion 13, the logical half. The other half is in `doctor.test.ts`.
// ---------------------------------------------------------------------------

test('a bind that is NOT loopback gets no local origin at all', () => {
  // This is the whole reason the condition lives in one file. With
  // `listen.interface: "tailscale0"` the bind resolves to a real private address,
  // and composing a local origin from it unconditionally would hand the policy
  // `http://100.87.1.2:7777` as a declared, accepted origin — quietly restoring the
  // tailnet-IP route that moving to a loopback bind exists to close.
  const policy = policyFor({
    publicOrigin: PUBLIC,
    address: '100.87.1.2',
    port: 7777,
    extraOrigins: [],
  })
  assert.equal(policy.localOrigin, undefined)
  assert.equal(originAllowed('http://100.87.1.2:7777', policy), false)
})

test('a LAN bind gets no local origin either', () => {
  const policy = policyFor({
    publicOrigin: PUBLIC,
    address: '192.168.1.50',
    port: 7777,
    extraOrigins: [],
  })
  assert.equal(policy.localOrigin, undefined)
})

test('the IPv6 loopback counts as loopback, and arrives canonical', () => {
  // `isLoopback` accepts `::1` in both spellings, so without canonicalisation the
  // long form would produce a local origin no browser ever sends.
  const policy = policyFor({
    publicOrigin: PUBLIC,
    address: '0:0:0:0:0:0:0:1',
    port: 7777,
    extraOrigins: [],
  })
  assert.equal(policy.localOrigin, 'http://[::1]:7777')
})

test('the public origin is passed through untouched, never re-derived', () => {
  const policy = policyFor({
    publicOrigin: PUBLIC,
    address: '127.0.0.1',
    port: 7777,
    extraOrigins: [],
  })
  assert.equal(policy.publicOrigin, PUBLIC)
})

test('extra origins survive composition', () => {
  const policy = policyFor({
    publicOrigin: PUBLIC,
    address: '127.0.0.1',
    port: 7778,
    extraOrigins: ['http://localhost:5173'],
  })
  assert.deepEqual(policy.extra, ['http://localhost:5173'])
  assert.equal(originAllowed('http://localhost:5173', policy), true)
})
