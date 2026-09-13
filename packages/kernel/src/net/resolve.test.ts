import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { networkInterfaces } from 'node:os'
import type { ListenConfig } from '@factotum/core'
import type { BootError } from '../errors.ts'
import { resolveListen } from './resolve.ts'
import { verifyBound } from './verify.ts'
import { baseUrl } from './url.ts'

type Interfaces = typeof networkInterfaces

/** A machine with Tailscale up, a LAN address and loopback. */
const typical: Interfaces = () =>
  ({
    lo0: [{ address: '127.0.0.1', internal: true } as never],
    en0: [{ address: '192.168.1.42', internal: false } as never],
    utun4: [{ address: '100.87.1.2', internal: false } as never],
  }) as never

/** No Tailscale — the state of someone who just cloned the project. */
const noTailscale: Interfaces = () =>
  ({
    lo0: [{ address: '127.0.0.1', internal: true } as never],
    en0: [{ address: '192.168.1.42', internal: false } as never],
  }) as never

const listen = (over: Partial<ListenConfig>): ListenConfig =>
  ({ port: 7777, extraOrigins: [], ...over }) as ListenConfig

test('a declared address is used when the machine still has it', () => {
  const resolved = resolveListen(listen({ address: '100.87.1.2' }), typical)
  assert.equal(resolved.address, '100.87.1.2')
  assert.equal(resolved.port, 7777)
  assert.equal(resolved.from.kind, 'address')
})

test('a declared interface resolves to its external address', () => {
  const resolved = resolveListen(listen({ interface: 'utun4' }), typical)
  assert.equal(resolved.address, '100.87.1.2')
  assert.equal(resolved.from.kind, 'interface')
})

test('an address that has vanished says so and points at init', () => {
  // Criterion 14 bis: valid when init wrote it, then the machine changed tailnets.
  assert.throws(
    () => resolveListen(listen({ address: '100.99.99.99' }), typical),
    (error: BootError) => {
      assert.equal(error.code, 'listen-unresolvable')
      assert.match(error.message, /no interface on this machine has it/)
      assert.match(error.message, /utun4=100\.87\.1\.2/) // says what it DID see
      assert.match(error.remedy, /factotum init/)
      return true
    },
  )
})

test('a missing interface lists what it looked for and what it found', () => {
  assert.throws(
    () => resolveListen(listen({ interface: 'tailscale0' }), noTailscale),
    (error: BootError) => {
      assert.match(error.message, /"tailscale0"/)
      assert.match(error.message, /en0=192\.168\.1\.42/)
      // And it warns about the macOS trap rather than just failing.
      assert.match(error.remedy, /utunN number/)
      return true
    },
  )
})

test('it never falls back to loopback or to everything when resolution fails', () => {
  // The failure mode this whole file exists to prevent.
  for (const bad of [listen({ interface: 'nope' }), listen({ address: '10.9.9.9' })]) {
    assert.throws(() => resolveListen(bad, noTailscale))
  }
})

test('a public address is refused with the ranges named', () => {
  assert.throws(
    () =>
      resolveListen(listen({ address: '203.0.113.7' }), (() =>
        ({ en0: [{ address: '203.0.113.7', internal: false } as never] }) as never) as Interfaces),
    (error: BootError) => {
      assert.equal(error.code, 'listen-out-of-range')
      assert.match(error.message, /100\.64\/10/)
      return true
    },
  )
})

test('a wide bind is refused with the reason, not just the range list', () => {
  assert.throws(
    () =>
      resolveListen(listen({ address: '0.0.0.0' }), (() =>
        ({ en0: [{ address: '0.0.0.0', internal: false } as never] }) as never) as Interfaces),
    (error: BootError) => {
      assert.match(error.message, /every interface/)
      assert.match(error.remedy, /proxy in front/)
      return true
    },
  )
})

test('loopback is accepted when declared, which is what dev uses', () => {
  const resolved = resolveListen(listen({ address: '127.0.0.1', port: 7778 }), typical)
  assert.equal(resolved.address, '127.0.0.1')
})

test('loopback found on an interface is NOT accepted', () => {
  // lo0 is internal, so it is not a candidate; and even reached, the range check
  // only admits loopback when it was written down.
  assert.throws(() => resolveListen(listen({ interface: 'lo0' }), typical))
})

// ---------------------------------------------------------------------------
// verify: what actually happened
// ---------------------------------------------------------------------------

test('a bind that matches is accepted', () => {
  assert.deepEqual(
    verifyBound({ address: '100.87.1.2', port: 7777 }, { address: '100.87.1.2', port: 7777 }),
    { ok: true },
  )
})

test('a dual-stack report of the same address is accepted', () => {
  // Without normalisation this aborts a correct install — the fail-closed remedy
  // causing the failure it exists to prevent.
  assert.deepEqual(
    verifyBound({ address: '100.87.1.2', port: 7777 }, { address: '::ffff:100.87.1.2', port: 7777 }),
    { ok: true },
  )
})

test('a wide bind that slipped through is caught after the fact', () => {
  const verdict = verifyBound({ address: '100.87.1.2', port: 7777 }, { address: '0.0.0.0', port: 7777 })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.actual, '0.0.0.0:7777')
})

test('a different port is caught', () => {
  assert.equal(
    verifyBound({ address: '100.87.1.2', port: 7777 }, { address: '100.87.1.2', port: 1234 }).ok,
    false,
  )
})

test('a socket that reports nothing is a failure, not a pass', () => {
  const verdict = verifyBound({ address: '100.87.1.2', port: 7777 }, null)
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok === false ? verdict.actual : '', /nothing/)
})

// ---------------------------------------------------------------------------
// url
// ---------------------------------------------------------------------------

test('an IPv6 address is bracketed so the QR carries a URL a phone can open', () => {
  assert.equal(baseUrl('fd7a:115c:a1e0::1', 7777), 'http://[fd7a:115c:a1e0::1]:7777')
  assert.equal(baseUrl('fe80::1%utun4', 7777), 'http://[fe80::1]:7777')
})

test('an IPv4 address is left alone', () => {
  assert.equal(baseUrl('100.87.1.2', 7777), 'http://100.87.1.2:7777')
})
