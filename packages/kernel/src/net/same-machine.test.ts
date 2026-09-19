import { test } from 'node:test'
import assert from 'node:assert/strict'
import { originPolicy } from './origin.ts'
import { isSameMachine, sourceIpOf } from './same-machine.ts'
import type { Interfaces } from './resolve.ts'

const PUBLIC = 'https://mimac.tail1234.ts.net'
const LOCAL = 'http://127.0.0.1:7877'
const policy = originPolicy(PUBLIC, LOCAL)
const MAC = '100.71.174.49'
const PHONE = '100.88.12.7'

/** The Mac's interfaces, faked: loopback, the LAN and the tailnet (spec 2026-09-18, A6). */
const interfaces = (() => ({
  lo0: [{ address: '127.0.0.1', internal: true }, { address: '::1', internal: true }],
  en0: [{ address: '192.168.1.20', internal: false }],
  utun4: [{ address: MAC, internal: false }, { address: 'fd7a:115c:a1e0::1%utun4', internal: false }],
})) as unknown as Interfaces

test('a page loaded from the loopback origin is this machine, with no IP needed (design D12)', () => {
  assert.equal(isSameMachine({ origin: LOCAL, policy, sourceIp: undefined, interfaces }), true)
})

test('through serve, the Mac’s own tailnet IP is this machine', () => {
  assert.equal(isSameMachine({ origin: PUBLIC, policy, sourceIp: MAC, interfaces }), true)
  assert.equal(isSameMachine({ origin: PUBLIC, policy, sourceIp: `::ffff:${MAC}`, interfaces }), true, 'mapped IPv4')
  assert.equal(isSameMachine({ origin: PUBLIC, policy, sourceIp: 'fd7a:115c:a1e0::1', interfaces }), true, 'IPv6, zone stripped')
})

test('through serve, the phone’s IP is not', () => {
  assert.equal(isSameMachine({ origin: PUBLIC, policy, sourceIp: PHONE, interfaces }), false)
})

test('the public origin with no IP is NOT this machine: never classified by missing data', () => {
  assert.equal(isSameMachine({ origin: PUBLIC, policy, sourceIp: undefined, interfaces }), false)
  assert.equal(isSameMachine({ origin: undefined, policy, sourceIp: undefined, interfaces }), false)
})

test('without a loopback bind there is no local origin, and an undefined Origin never matches it', () => {
  const noLocal = originPolicy(PUBLIC, undefined)
  assert.equal(isSameMachine({ origin: undefined, policy: noLocal, sourceIp: undefined, interfaces }), false)
})

test('the source IP is x-forwarded-for, and ONLY when serve says it put it there (A6)', () => {
  assert.equal(sourceIpOf({ 'x-forwarded-for': MAC, 'tailscale-headers-info': 'https://tailscale.com/s/serve-headers' }), MAC)
  assert.equal(sourceIpOf({ 'x-forwarded-for': `${PHONE}, 10.0.0.1`, 'tailscale-headers-info': 'x' }), PHONE, 'the first hop')
  assert.equal(sourceIpOf({ 'x-forwarded-for': MAC }), undefined, 'a direct request can carry anything: not believed')
  assert.equal(sourceIpOf({ 'tailscale-headers-info': 'x' }), undefined)
})
