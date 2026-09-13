import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classify,
  isLoopback,
  isWideBind,
  normalize,
  sameAddress,
  stripZone,
} from './ranges.ts'

// ---------------------------------------------------------------------------
// The three normalisations
// ---------------------------------------------------------------------------

test('an IPv4-mapped address is the same host as its IPv4 form', () => {
  // Without this, the post-listen check aborts on a correct dual-stack install:
  // listen() on 100.64.0.1 can report ::ffff:100.64.0.1 back.
  assert.equal(normalize('::ffff:100.64.0.1'), '100.64.0.1')
  assert.equal(sameAddress('::ffff:100.64.0.1', '100.64.0.1'), true)
})

test('a zone suffix is stripped before anything else looks at the address', () => {
  assert.equal(stripZone('fe80::1%utun4'), 'fe80::1')
  assert.equal(normalize('fd7a:115c:a1e0::1%utun4'), normalize('fd7a:115c:a1e0::1'))
})

test('the same IPv6 address written differently compares equal', () => {
  assert.equal(sameAddress('fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:0:0:0:0:1'), true)
})

test('text that is not an address normalises to nothing', () => {
  assert.equal(normalize('not-an-address'), undefined)
  assert.equal(normalize('999.1.1.1'), undefined)
  assert.equal(sameAddress('nonsense', 'nonsense'), false)
})

// ---------------------------------------------------------------------------
// Wide binds — the one thing this project never negotiates
// ---------------------------------------------------------------------------

test('every spelling of "listen on everything" is caught', () => {
  // A string comparison against '0.0.0.0' lets all but the first through. That is
  // the hole in the predecessor's refine, which this project cites approvingly.
  for (const wide of ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0']) {
    assert.equal(isWideBind(wide), true, `${wide} should be a wide bind`)
  }
})

test('a real address is not a wide bind', () => {
  assert.equal(isWideBind('100.64.0.1'), false)
  assert.equal(isWideBind('::1'), false)
})

test('a wide bind is refused with its own reason, not "out of range"', () => {
  const verdict = classify('0.0.0.0', true)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.why, 'wide-bind')
})

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

test('a Tailscale CGNAT address is accepted and says so', () => {
  const verdict = classify('100.87.12.34', false)
  assert.equal(verdict.ok, true)
  assert.match(verdict.ok === true ? verdict.what : '', /Tailscale/)
})

test('RFC1918 and ULA are accepted', () => {
  for (const address of ['10.1.2.3', '172.16.0.1', '192.168.1.1', 'fd7a:115c:a1e0::1']) {
    assert.equal(classify(address, false).ok, true, `${address} should be accepted`)
  }
})

test('a public address is refused', () => {
  for (const address of ['203.0.113.7', '8.8.8.8', '2001:4860:4860::8888']) {
    const verdict = classify(address, true)
    assert.equal(verdict.ok, false, `${address} should be refused`)
    assert.equal(verdict.ok === false && verdict.why, 'out-of-range')
  }
})

test('172.32.0.1 is outside RFC1918 even though 172.16.0.1 is inside', () => {
  assert.equal(classify('172.32.0.1', false).ok, false)
})

test('loopback is accepted only when it was declared, never auto-detected', () => {
  // The nuance that keeps a failed detection from quietly landing somewhere useless.
  assert.equal(classify('127.0.0.1', true).ok, true)
  assert.equal(classify('::1', true).ok, true)
  assert.equal(classify('127.0.0.1', false).ok, false)
})

test('nonsense is refused as not-an-address', () => {
  const verdict = classify('utun4', true)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false && verdict.why, 'not-an-address')
})

test('loopback is recognisable on its own', () => {
  assert.equal(isLoopback('127.0.0.1'), true)
  assert.equal(isLoopback('127.5.5.5'), true)
  assert.equal(isLoopback('::1'), true)
  assert.equal(isLoopback('100.64.0.1'), false)
  assert.equal(isLoopback('nonsense'), false)
})
