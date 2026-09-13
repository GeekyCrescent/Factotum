import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describePolicy, originAllowed, originPolicy } from './origin.ts'

const tailnet = originPolicy('100.87.1.2', 7777)
const loopback = originPolicy('127.0.0.1', 7778)

// ---------------------------------------------------------------------------
// The three legitimate ways to reach one host. These are the regression tests:
// two earlier designs of this policy would have answered 403 to some of them.
// ---------------------------------------------------------------------------

test('the bind address itself is allowed', () => {
  assert.equal(originAllowed('http://100.87.1.2:7777', tailnet), true)
})

test('the MagicDNS name is allowed', () => {
  // A policy derived from `listen` knows only the IP and would 403 here — the
  // failure the predecessor calls "the worst possible symptom".
  assert.equal(originAllowed('http://mymac.tail1234.ts.net:7777', tailnet), true)
})

test('localhost is allowed when the daemon actually listens on loopback', () => {
  assert.equal(originAllowed('http://localhost:7778', loopback), true)
  assert.equal(originAllowed('http://127.0.0.1:7778', loopback), true)
})

test('localhost is refused when the bind is not loopback', () => {
  // That address does not answer, so no client could have been loaded from it.
  assert.equal(originAllowed('http://localhost:7777', tailnet), false)
})

// ---------------------------------------------------------------------------
// What must not get in
// ---------------------------------------------------------------------------

test('a page on the public internet is refused', () => {
  assert.equal(originAllowed('https://evil.com', tailnet), false)
  assert.equal(originAllowed('http://evil.com:7777', tailnet), false)
})

test('another machine on the LAN is refused', () => {
  // An earlier design admitted any private-range address, which is the objection
  // this policy exists to answer.
  assert.equal(originAllowed('http://192.168.1.1:7777', tailnet), false)
  assert.equal(originAllowed('http://10.0.0.5:7777', tailnet), false)
})

test('another service on this same machine is refused', () => {
  assert.equal(originAllowed('http://localhost:3000', loopback), false)
  assert.equal(originAllowed('http://127.0.0.1:3000', loopback), false)
})

test('a Tailscale Funnel name is refused because Funnel serves on 443', () => {
  // Funnel hands out public *.ts.net names to anyone with a free account. The port
  // is what closes it — which is why this protection disappears the day TLS sits in
  // front on 443, and why that is written into the design's §11.
  assert.equal(originAllowed('https://evil.tail9999.ts.net', tailnet), false)
})

test('a suffix trap is refused', () => {
  // `endsWith('127.0.0.1')` or a substring test would admit these. The attacker owns
  // the name; only exact comparison keeps them out.
  assert.equal(originAllowed('http://127.0.0.1.attacker.com:7777', tailnet), false)
  assert.equal(originAllowed('http://127.0.0.1.attacker.com:7778', loopback), false)
  assert.equal(originAllowed('http://100.87.1.2.attacker.com:7777', tailnet), false)
  assert.equal(originAllowed('http://evilts.net:7777', tailnet), false)
})

test('the right host on the wrong port is refused', () => {
  assert.equal(originAllowed('http://100.87.1.2:9999', tailnet), false)
  assert.equal(originAllowed('http://mymac.tail1234.ts.net:443', tailnet), false)
})

test('text that is not an origin is refused rather than throwing', () => {
  assert.equal(originAllowed('not an origin', tailnet), false)
  assert.equal(originAllowed('', tailnet), false)
})

// ---------------------------------------------------------------------------
// Escape hatches and shapes
// ---------------------------------------------------------------------------

test('an operator can add a whole origin for a proxy in front', () => {
  const withProxy = originPolicy('100.87.1.2', 7777, ['https://factotum.example.com'])
  assert.equal(originAllowed('https://factotum.example.com', withProxy), true)
  assert.equal(originAllowed('https://other.example.com', withProxy), false)
})

test('an IPv6 bind is matched through the brackets a URL adds', () => {
  const v6 = originPolicy('fd7a:115c:a1e0::1', 7777)
  assert.equal(originAllowed('http://[fd7a:115c:a1e0::1]:7777', v6), true)
  assert.equal(originAllowed('http://[fd7a:115c:a1e0:0:0:0:0:1]:7777', v6), true)
})

test('the policy describes itself for doctor and for a 403 message', () => {
  const described = describePolicy(loopback).join('\n')
  assert.match(described, /same host and same port \(7778\)/)
  assert.match(described, /localhost/)
  assert.doesNotMatch(describePolicy(tailnet).join('\n'), /localhost/)
})
