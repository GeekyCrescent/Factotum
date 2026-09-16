import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localUrl } from './url.ts'

// These two moved here from `resolve.test.ts`, which had no business owning them and
// had to import `url.ts` to do it. This file did not exist before this spec.

test('an IPv6 address is bracketed so the URL is one a phone can open', () => {
  assert.equal(localUrl('fd7a:115c:a1e0::1', 7777), 'http://[fd7a:115c:a1e0::1]:7777')
  assert.equal(localUrl('fe80::1%utun4', 7777), 'http://[fe80::1]:7777')
})

test('an IPv4 address is left alone', () => {
  assert.equal(localUrl('100.87.1.2', 7777), 'http://100.87.1.2:7777')
})

// ---------------------------------------------------------------------------
// And the case this spec added, which is the one that can actually bite.
// ---------------------------------------------------------------------------

test('the two spellings of the IPv6 loopback collapse to one canonical origin', () => {
  // This replaces the test that died with `sameAddress`: `origin.test.ts` used to
  // prove that a bind of `fd7a:115c:a1e0::1` matched an origin written
  // `fd7a:115c:a1e0:0:0:0:0:1`, because the policy normalised on every request.
  // The policy no longer normalises anything, so if this did not canonicalise, a
  // config written the long way would produce a `localOrigin` that the browser's
  // short form never equals — and the rescue route would 403 with two strings that
  // look the same in `doctor`'s output.
  assert.equal(localUrl('0:0:0:0:0:0:0:1', 7777), 'http://[::1]:7777')
  assert.equal(localUrl('::1', 7777), 'http://[::1]:7777')
  assert.equal(localUrl('0:0:0:0:0:0:0:1', 7777), localUrl('::1', 7777))
})

test('a long-form tailnet ULA collapses the same way', () => {
  assert.equal(localUrl('fd7a:115c:a1e0:0:0:0:0:1', 7777), 'http://[fd7a:115c:a1e0::1]:7777')
})
