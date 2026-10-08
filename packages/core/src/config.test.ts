import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCanonicalOrigin,
  listenSchema,
  moduleEntrySchema,
  moduleIdSchema,
  rootConfigSchema,
} from './config.ts'

// ---------------------------------------------------------------------------
// The Zod trap. This is the most important test in the package.
// ---------------------------------------------------------------------------

test('a module fragment keeps keys the root schema has never heard of', () => {
  // Arrange — `greeting` is example's, and the root schema knows nothing about it.
  const raw = { enabled: true, greeting: 'hello', tickSeconds: 30 }

  // Act
  const parsed = moduleEntrySchema.parse(raw)

  // Assert — without `.catchall`, these are silently dropped and the module would
  // receive an empty fragment. In the predecessor project the same trap deleted
  // fields from disk on the next write.
  assert.equal(parsed['greeting'], 'hello')
  assert.equal(parsed['tickSeconds'], 30)
  assert.equal(parsed.enabled, true)
})

test('unknown module keys survive validation of the whole root config', () => {
  const parsed = rootConfigSchema.parse({
    environment: 'prod',
    listen: { address: '127.0.0.1', port: 7777 },
    publicOrigin: 'https://mimac.tail1234.ts.net',
    modules: { example: { enabled: true, greeting: 'hi' } },
  })

  assert.equal(parsed.modules['example']?.['greeting'], 'hi')
})

test('a module is off unless the config says otherwise', () => {
  assert.equal(moduleEntrySchema.parse({}).enabled, false)
})

// ---------------------------------------------------------------------------
// listen: startup never guesses
// ---------------------------------------------------------------------------

test('accepts an address on its own', () => {
  const parsed = listenSchema.parse({ address: '100.87.1.2', port: 7777 })
  assert.equal(parsed.address, '100.87.1.2')
  assert.deepEqual(parsed.extraOrigins, [])
})

test('accepts an interface on its own', () => {
  assert.equal(listenSchema.parse({ interface: 'tailscale0', port: 7777 }).interface, 'tailscale0')
})

test('rejects declaring neither address nor interface', () => {
  // This is the shape the predecessor project allowed, and the reason startup there
  // could fall back to a default instead of refusing.
  assert.equal(listenSchema.safeParse({ port: 7777 }).success, false)
})

test('rejects declaring both address and interface', () => {
  const result = listenSchema.safeParse({
    address: '100.87.1.2',
    interface: 'utun4',
    port: 7777,
  })
  assert.equal(result.success, false)
})

test('rejects a privileged port', () => {
  assert.equal(listenSchema.safeParse({ address: '100.87.1.2', port: 80 }).success, false)
})

// ---------------------------------------------------------------------------
// module ids
// ---------------------------------------------------------------------------

test('accepts a well formed module id', () => {
  assert.equal(moduleIdSchema.parse('example'), 'example')
  assert.equal(moduleIdSchema.parse('shopping-list'), 'shopping-list')
})

test('rejects ids that would escape the state directory', () => {
  for (const bad of ['../etc', 'a/b', '.hidden', 'Example', '1st', '']) {
    assert.equal(moduleIdSchema.safeParse(bad).success, false, `should reject ${bad}`)
  }
})

// ---------------------------------------------------------------------------
// root config
// ---------------------------------------------------------------------------

test('modules defaults to an empty record', () => {
  const parsed = rootConfigSchema.parse({
    environment: 'dev',
    listen: { address: '127.0.0.1', port: 7778 },
    publicOrigin: 'http://127.0.0.1:7778',
  })
  assert.deepEqual(parsed.modules, {})
})

test('rejects an environment that is not one of the two', () => {
  const result = rootConfigSchema.safeParse({
    environment: 'staging',
    listen: { address: '127.0.0.1', port: 7778 },
    publicOrigin: 'http://127.0.0.1:7778',
  })
  assert.equal(result.success, false)
})

// ---------------------------------------------------------------------------
// publicOrigin
//
// The origin policy compares raw strings, so a value that is not canonical here
// means 403 on everything, with `doctor` printing two values that look identical.
// These are the shapes an owner actually produces.
// ---------------------------------------------------------------------------

const withPublicOrigin = (publicOrigin: unknown) =>
  rootConfigSchema.safeParse({
    environment: 'prod',
    listen: { address: '127.0.0.1', port: 7777 },
    publicOrigin,
    modules: {},
  })

test('publicOrigin is required — a config without it does not validate', () => {
  const result = rootConfigSchema.safeParse({
    environment: 'prod',
    listen: { address: '127.0.0.1', port: 7777 },
    modules: {},
  })
  assert.equal(result.success, false)
})

test('a bare canonical origin validates', () => {
  assert.equal(withPublicOrigin('https://mimac.tail1234.ts.net').success, true)
})

test('a non-default port validates, because serve can be told to use one', () => {
  // Measured: `tailscale serve --bg --https=8443 <target>` works and produces
  // `https://<fqdn>:8443/`. This case must keep working.
  assert.equal(withPublicOrigin('https://mimac.tail1234.ts.net:8443').success, true)
})

test('the local origin validates, which is what dev uses', () => {
  assert.equal(withPublicOrigin('http://127.0.0.1:7778').success, true)
})

test('a trailing DOT is refused — the one the naive guard let through', () => {
  // THIS IS THE CASE THE FOURTH REVISION OF THIS DESIGN SHIPPED BROKEN.
  // `new URL('https://x.ts.net.').origin` is byte-identical to its input, so a guard
  // written only as `v === new URL(v).origin` accepts it. And it is not exotic:
  // `tailscale status --json` returns `Self.DNSName` with the trailing dot, measured
  // on a real tailnet as 'juans-macbook-pro.tailbd0167.ts.net.' — the exact string
  // `init` composes from. The browser sends it without. Two strings that look the
  // same, 403 on every POST, and nothing in the logs to explain it.
  assert.equal(new URL('https://mimac.tail1234.ts.net.').origin, 'https://mimac.tail1234.ts.net.')
  assert.equal(withPublicOrigin('https://mimac.tail1234.ts.net.').success, false)
})

test('a trailing slash is refused — what copying from the address bar gives you', () => {
  assert.equal(withPublicOrigin('https://mimac.tail1234.ts.net/').success, false)
})

test('upper case is refused, because the comparison does not fold case', () => {
  assert.equal(withPublicOrigin('https://MiMac.Tail1234.ts.net').success, false)
})

test('embedded credentials are refused', () => {
  assert.equal(withPublicOrigin('https://user:pass@mimac.tail1234.ts.net').success, false)
})

test('an explicit :443 is refused, because a browser never sends it', () => {
  assert.equal(withPublicOrigin('https://mimac.tail1234.ts.net:443').success, false)
})

test('a path is refused', () => {
  assert.equal(withPublicOrigin('https://mimac.tail1234.ts.net/app').success, false)
})

test('something that is not a URL at all is refused rather than throwing', () => {
  assert.equal(withPublicOrigin('mimac.tail1234.ts.net').success, false)
  assert.equal(withPublicOrigin('').success, false)
})

test('the failure names the field, because this spec invalidates every old config', () => {
  // `doctor` prints the path of the first issue. Without it, every config written
  // before this spec reports "Invalid input" and does not say which key is wrong.
  const result = withPublicOrigin('https://mimac.tail1234.ts.net/')
  assert.equal(result.success, false)
  assert.deepEqual(result.error?.issues[0]?.path, ['publicOrigin'])
})

// ---------------------------------------------------------------------------
// peers (spec 2026-10-07, D1): the publicOrigin rule, reused and not copied
// ---------------------------------------------------------------------------

const withPeers = (peers: unknown) =>
  rootConfigSchema.safeParse({
    environment: 'prod',
    listen: { address: '127.0.0.1', port: 7777 },
    publicOrigin: 'https://mimac.tail1234.ts.net',
    peers,
  })

test('a config without peers is still valid, and has none', () => {
  const parsed = withPublicOrigin('https://mimac.tail1234.ts.net')
  assert.equal(parsed.success, true)
  assert.deepEqual(parsed.data?.peers, [])
})

test('one canonical peer is accepted', () => {
  const parsed = withPeers([{ origin: 'https://omarchy.tail1234.ts.net' }])
  assert.equal(parsed.success, true)
  assert.deepEqual(parsed.data?.peers, [{ origin: 'https://omarchy.tail1234.ts.net' }])
})

test('a peer with a trailing dot or a path is refused, with a message of its own', () => {
  for (const origin of ['https://omarchy.tail1234.ts.net.', 'https://omarchy.tail1234.ts.net/app']) {
    const result = withPeers([{ origin }])
    assert.equal(result.success, false, origin)
    assert.deepEqual(result.error?.issues[0]?.path, ['peers', 0, 'origin'])
    // Its own message: a mistyped peer must not say "publicOrigin must…".
    assert.doesNotMatch(result.error?.issues[0]?.message ?? '', /publicOrigin/)
    assert.match(result.error?.issues[0]?.message ?? '', /peer/)
  }
})

test('two peers are refused: one peer at most (D1)', () => {
  const result = withPeers([{ origin: 'https://a.tail1234.ts.net' }, { origin: 'https://b.tail1234.ts.net' }])
  assert.equal(result.success, false)
  assert.deepEqual(result.error?.issues[0]?.path, ['peers'])
})

test('isCanonicalOrigin is the one rule both schemas use', () => {
  assert.equal(isCanonicalOrigin('https://mimac.tail1234.ts.net'), true)
  assert.equal(isCanonicalOrigin('http://127.0.0.1:7777'), true)
  assert.equal(isCanonicalOrigin('https://mimac.tail1234.ts.net.'), false)
  assert.equal(isCanonicalOrigin('https://mimac.tail1234.ts.net/'), false)
  assert.equal(isCanonicalOrigin('not a url'), false)
})
