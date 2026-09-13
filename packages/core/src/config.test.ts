import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
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
    listen: { address: '100.87.1.2', port: 7777 },
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
  })
  assert.deepEqual(parsed.modules, {})
})

test('rejects an environment that is not one of the two', () => {
  const result = rootConfigSchema.safeParse({
    environment: 'staging',
    listen: { address: '127.0.0.1', port: 7778 },
  })
  assert.equal(result.success, false)
})
