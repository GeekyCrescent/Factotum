import { test } from 'node:test'
import assert from 'node:assert/strict'

import { senderVerified, stripQuotesAndComments } from './sender.ts'

const GMAIL = 'mx.google.com;'

test('dmarc=pass from Gmail verifies the sender (header.from the From’s domain, or absent)', () => {
  assert.equal(senderVerified([`${GMAIL} spf=pass smtp.mailfrom=acme.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=acme.com`], 'jo@acme.com'), true)
  assert.equal(senderVerified([`${GMAIL} dmarc=pass`], 'jo@acme.com'), true)
  assert.equal(senderVerified([`${GMAIL} dmarc=pass header.from=ACME.com`], 'jo@acme.com'), true)
  assert.equal(senderVerified([`${GMAIL} dmarc=pass header.from=evil.example`], 'jo@acme.com'), false)
})

test('dkim=pass verifies only when its signing domain (header.d, or header.i as Gmail writes it) is the From’s', () => {
  assert.equal(senderVerified([`${GMAIL} dkim=pass header.i=@acme.com header.s=s1 header.b=AbC`], 'jo@acme.com'), true)
  assert.equal(senderVerified([`${GMAIL} dkim=pass header.d=mg.acme.com header.s=s1`], 'jo@acme.com'), true)
  assert.equal(senderVerified([`${GMAIL} dkim=pass header.i=@evil.example header.s=s1`], 'jo@acme.com'), false, 'unaligned')
  assert.equal(senderVerified([`${GMAIL} dkim=pass`], 'jo@acme.com'), false, 'no signing domain')
  assert.equal(senderVerified([`${GMAIL} dkim=fail header.i=@acme.com`], 'jo@acme.com'), false)
})

test('nothing else verifies: no header, spf alone, fail/none, another server, or a forged header below Gmail’s', () => {
  assert.equal(senderVerified([], 'jo@acme.com'), false)
  assert.equal(senderVerified([`${GMAIL} spf=pass smtp.mailfrom=acme.com`], 'jo@acme.com'), false)
  assert.equal(senderVerified([`${GMAIL} dmarc=fail header.from=acme.com; dkim=none`], 'jo@acme.com'), false)
  assert.equal(senderVerified(['evil.example; dmarc=pass header.from=acme.com'], 'jo@acme.com'), false)
  assert.equal(senderVerified([`${GMAIL} dmarc=fail header.from=acme.com`, `${GMAIL} dmarc=pass header.from=acme.com`], 'jo@acme.com'), false, 'only the first, Gmail’s own')
  assert.equal(senderVerified([`${GMAIL} dmarc=pass`], 'no-at-sign'), false)
  assert.equal(senderVerified([`${GMAIL} (a comment; with a semicolon) dmarc=pass header.from=acme.com`], 'jo@acme.com'), true, 'comments are dropped')
})

test('dkim alignment without the Public Suffix List: the From’s domain, a parent or a subdomain — never a sibling', () => {
  assert.equal(senderVerified([`${GMAIL} dkim=pass header.d=acme.com`], 'jo@mail.acme.com.au'), false)
  assert.equal(senderVerified([`${GMAIL} dkim=pass header.d=acme.com.au`], 'jo@mail.acme.com.au'), true)
  assert.equal(senderVerified([`${GMAIL} dkim=pass header.d=evil.github.io`], 'jo@acme.github.io'), false, 'a shared suffix is not alignment')
  assert.equal(senderVerified([`${GMAIL} dkim=pass header.d=evil.com.au`], 'jo@acme.com.au'), false)
})

test('a value the sender chose cannot add a verdict: quoted strings and comments are read as RFC 8601 says', () => {
  const smuggled = `${GMAIL} spf=softfail smtp.mailfrom="x; dmarc=pass header.from=acme.com"@evil.example; dmarc=fail header.from=acme.com`
  assert.equal(senderVerified([smuggled], 'jo@acme.com'), false)
  const escaped = `${GMAIL} spf=none smtp.mailfrom="a\\"; dmarc=pass header.from=acme.com"@evil.example`
  assert.equal(senderVerified([escaped], 'jo@acme.com'), false, 'an escaped quote does not end the string')
  const nested = `${GMAIL} (outer (inner; dmarc=pass header.from=acme.com) still a comment; dkim=pass header.d=acme.com) dmarc=fail`
  assert.equal(senderVerified([nested], 'jo@acme.com'), false)
  assert.equal(stripQuotesAndComments('A=b (c (d) e) f="g;h" i'), 'a=b  f="" i')
})
