import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BootError } from './errors.ts'

test('a boot error prints what happened and what to do about it', () => {
  // "Failed closed and I do not know why" is the standard complaint about projects
  // that fail closed correctly. The remedy is part of the type so it cannot be
  // forgotten at a call site.
  const error = new BootError(
    'listen-out-of-range',
    '203.0.113.7 is not in a private range',
    'run `factotum init` to pick a Tailscale address',
  )

  assert.equal(
    error.format(),
    '203.0.113.7 is not in a private range\n  → run `factotum init` to pick a Tailscale address',
  )
  assert.equal(error.name, 'BootError')
  assert.ok(error instanceof Error)
})
