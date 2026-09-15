import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describePolicy, originAllowed, originPolicy } from './origin.ts'

const PUBLIC = 'https://mimac.tail1234.ts.net'

/** The shipping shape: TLS in front, daemon on loopback, so both origins exist. */
const policy = originPolicy(PUBLIC, 'http://127.0.0.1:7777')
/** A bind that is not loopback: there is no rescue route to accept. */
const noLocal = originPolicy(PUBLIC, undefined)

// ---------------------------------------------------------------------------
// READ THIS BEFORE ADDING A CASE.
//
// THE NEGATIVE CASES BELOW CAN NO LONGER REGRESS, AND THAT IS NOT AN OVERSIGHT.
//
// This file used to open by saying "the three legitimate ways to reach one host —
// these are the regression tests", because the policy decided BY SHAPE and each
// negative was refused by a DIFFERENT rule: one by the port comparison, one by the
// absence of a suffix, one by an address range. Breaking any single rule broke a
// single test, which is what made them regression tests.
//
// The policy now compares two declared origins with `===`. Every negative below is
// therefore refused by ONE trivial mechanism — string inequality — so they all pass
// or all fail together, and no realistic bug makes exactly one of them flip. THEIR
// VALUE IS NOW DOCUMENTARY: they record which attacks this file was built against,
// and they are kept for that reason and not deleted (criterion 8).
//
// What actually defends this file now is two things, and if you weaken either one
// the loss is silent:
//
//   1. `the three non-canonical forms` below. It is the ONLY test that can tell a
//      raw `===` from a `new URL(x).origin` comparison, which would accept all
//      three. See its own comment.
//   2. A grep, not a test: `endsWith`, `startsWith` and `includes` are banned in
//      `origin.ts` except on the `extra` ARRAY. A substring test is how this policy
//      was got wrong before, and a grep catches it where a passing suite would not.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The one legitimate way in, and the rescue route
// ---------------------------------------------------------------------------

test('the declared public origin is allowed', () => {
  assert.equal(originAllowed(PUBLIC, policy), true)
})

test('another tailnet entirely is refused, though it is also a *.ts.net name', () => {
  // The deleted suffix rule accepted this. It is the whole reason for the rewrite:
  // `.ts.net` names are handed out to anyone with a free account, and Funnel serves
  // them over TLS on 443 — the same port this daemon now sits behind.
  assert.equal(originAllowed('https://otro.tail9999.ts.net', policy), false)
})

test('the loopback bind is allowed, because that is the way in if serve stops', () => {
  assert.equal(originAllowed('http://127.0.0.1:7777', policy), true)
})

test('the loopback bind is not allowed when the daemon does not listen there', () => {
  assert.equal(originAllowed('http://127.0.0.1:7777', noLocal), false)
})

// ---------------------------------------------------------------------------
// THE TEST THAT DISCRIMINATES. Do not fold it into the others.
// ---------------------------------------------------------------------------

test('the three non-canonical forms of the right host are refused', () => {
  // This is the only case in the file that distinguishes the implementation that
  // shipped from the one that looks equivalent. An `originAllowed` written as
  //     new URL(origin).origin === policy.publicOrigin
  // answers TRUE to all three, because `.origin` discards the path, discards the
  // credentials, and lower-cases the host. Measured against `serve`: a non-canonical
  // Origin reaches the daemon verbatim — the proxy does not normalise it — so these
  // are shapes that genuinely arrive, not shapes invented for a test.
  assert.equal(originAllowed('https://mimac.tail1234.ts.net/evil', policy), false)
  assert.equal(originAllowed('https://user:pass@mimac.tail1234.ts.net', policy), false)
  assert.equal(originAllowed('HTTPS://MIMAC.TAIL1234.TS.NET', policy), false)
})

// ---------------------------------------------------------------------------
// What must not get in. Documentary now — see the header.
// ---------------------------------------------------------------------------

test('a suffix trap is refused', () => {
  // `endsWith` or any substring test would admit these: the attacker owns the name.
  assert.equal(originAllowed('https://mimac.tail1234.ts.net.attacker.com', policy), false)
  assert.equal(originAllowed('http://127.0.0.1.attacker.com:7777', policy), false)
  const withProxy = originPolicy(PUBLIC, undefined, ['https://a.com'])
  assert.equal(originAllowed('https://a.com.evil.net', withProxy), false)
})

test('localhost is refused even though the daemon does listen on loopback', () => {
  // INVERTED BY THIS SPEC. It used to be allowed, on the reasoning that if the bind
  // is loopback then `localhost` resolves to it and could have loaded the client.
  // The policy no longer reasons: `http://localhost:7777` is simply a different
  // string from `http://127.0.0.1:7777`, and `doctor` prints the one that works.
  assert.equal(originAllowed('http://localhost:7777', policy), false)
})

test('another service on this same machine is refused', () => {
  assert.equal(originAllowed('http://localhost:3000', policy), false)
  assert.equal(originAllowed('http://127.0.0.1:3000', policy), false)
})

test('another machine on the LAN is refused', () => {
  // An earlier design admitted any private-range address, which is the objection
  // this policy exists to answer.
  assert.equal(originAllowed('http://192.168.1.1:7777', policy), false)
  assert.equal(originAllowed('http://10.0.0.5:7777', policy), false)
})

test('the tailnet IP of this very machine is refused', () => {
  // INVERTED BY THIS SPEC, and it is the change of model in one line: this used to
  // be one of "the three legitimate ways to reach one host". The bind is loopback
  // now, so nothing answers on the tailnet address and no client can load from it.
  assert.equal(originAllowed('http://100.87.1.2:7777', policy), false)
})

test('the MagicDNS name on the bind port is refused', () => {
  // INVERTED BY THIS SPEC. Reaching the daemon directly by MagicDNS is exactly what
  // the loopback bind removes; the public origin is the one TLS covers.
  assert.equal(originAllowed('http://mimac.tail1234.ts.net:7777', policy), false)
})

test('a page on the public internet is refused', () => {
  assert.equal(originAllowed('https://evil.com', policy), false)
  assert.equal(originAllowed('http://evil.com:7777', policy), false)
})

test('the right host on the wrong scheme or port is refused', () => {
  assert.equal(originAllowed('http://mimac.tail1234.ts.net', policy), false)
  assert.equal(originAllowed('https://mimac.tail1234.ts.net:8443', policy), false)
})

test('text that is not an origin is refused rather than throwing', () => {
  // Nothing in `originAllowed` parses any more, so this cannot throw — but the case
  // stays, because an implementation that reintroduces `new URL` would throw here.
  assert.equal(originAllowed('not an origin', policy), false)
  assert.equal(originAllowed('', policy), false)
})

// ---------------------------------------------------------------------------
// Escape hatch and self-description
// ---------------------------------------------------------------------------

test('an operator can add a whole origin for a proxy in front', () => {
  const withProxy = originPolicy(PUBLIC, undefined, ['https://factotum.example.com'])
  assert.equal(originAllowed('https://factotum.example.com', withProxy), true)
  assert.equal(originAllowed('https://other.example.com', withProxy), false)
})

test('the policy describes both origins, and says what the local one is for', () => {
  const described = describePolicy(policy).join('\n')
  assert.match(described, /https:\/\/mimac\.tail1234\.ts\.net \(publicOrigin\)/)
  assert.match(described, /http:\/\/127\.0\.0\.1:7777 \(the bind — the way in if serve stops\)/)
})

test('the description omits the local origin when the bind is not loopback', () => {
  // `doctor` prints this. Printing a rescue route that `boot` left undefined is how
  // `doctor` ends up lying about what the daemon actually accepts.
  const described = describePolicy(noLocal).join('\n')
  assert.match(described, /publicOrigin/)
  assert.doesNotMatch(described, /the way in if serve stops/)
})

test('extra origins are listed so a 403 can point at them', () => {
  const described = describePolicy(originPolicy(PUBLIC, undefined, ['https://a.com'])).join('\n')
  assert.match(described, /https:\/\/a\.com \(from listen\.extraOrigins\)/)
})
