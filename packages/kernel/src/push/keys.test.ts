import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateKeys, KEYS_FILE, type VapidKeys } from './keys.ts'

const FAKE: VapidKeys = {
  // Real shapes: an uncompressed P-256 point is 65 bytes → 87 base64url chars; a scalar is
  // 32 bytes → 43. Measured against web-push 3.6.7 in spec A7.
  publicKey: 'B'.repeat(87),
  privateKey: 'p'.repeat(43),
}

async function dir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'factotum-keys-'))
}

test('with nothing on disk, a pair is created, and only inside the push directory', async () => {
  const push = await dir()
  let generated = 0

  const result = await loadOrCreateKeys({ dir: push, generate: () => (generated++, FAKE) })

  assert.equal(result.kind, 'ready')
  assert.equal(result.kind === 'ready' && result.created, true)
  assert.equal(generated, 1)
  // Criterion 4a, structurally: the only writer writes under the push directory, so a key in
  // the repository is impossible rather than unlikely.
  const written = join(push, KEYS_FILE)
  assert.deepEqual(JSON.parse(await readFile(written, 'utf8')), FAKE)
  assert.equal(written.startsWith(push), true)
})

test('the key file is owner-only', async () => {
  const push = await dir()
  const previous = process.umask(0o000)
  try {
    await loadOrCreateKeys({ dir: push, generate: () => FAKE })
  } finally {
    process.umask(previous)
  }
  assert.equal((await stat(join(push, KEYS_FILE))).mode & 0o777, 0o600)
})

test('a second call returns the SAME pair and never generates again (criterion 2)', async () => {
  const push = await dir()
  await loadOrCreateKeys({ dir: push, generate: () => FAKE })

  let generated = 0
  const again = await loadOrCreateKeys({
    dir: push,
    generate: () => (generated++, { publicKey: 'X'.repeat(87), privateKey: 'x'.repeat(43) }),
  })

  assert.equal(generated, 0, 'a new pair silently invalidates every subscription')
  assert.equal(again.kind, 'ready')
  assert.deepEqual(again.kind === 'ready' && again.keys, FAKE)
  assert.equal(again.kind === 'ready' && again.created, false)
})

test('a corrupt key file DEGRADES with a reason and is left byte for byte as it was', async () => {
  const push = await dir()
  const file = join(push, KEYS_FILE)
  await writeFile(file, '{"publicKey": "trunc', 'utf8')

  let generated = 0
  const result = await loadOrCreateKeys({ dir: push, generate: () => (generated++, FAKE) })

  assert.equal(result.kind, 'unavailable')
  assert.match(result.kind === 'unavailable' ? result.reason : '', /keys\.json/)
  // The remedy travels with the reason, like every BootError in this repo.
  assert.match(result.kind === 'unavailable' ? result.reason : '', /delete/i)
  assert.equal(generated, 0)
  assert.equal(await readFile(file, 'utf8'), '{"publicKey": "trunc')
})

test('a well-formed JSON with the wrong shape is refused too, and not overwritten', async () => {
  const push = await dir()
  const file = join(push, KEYS_FILE)
  const wrong = JSON.stringify({ publicKey: 'short', privateKey: 'p'.repeat(43) })
  await writeFile(file, wrong, 'utf8')

  const result = await loadOrCreateKeys({ dir: push, generate: () => FAKE })

  assert.equal(result.kind, 'unavailable')
  assert.equal(await readFile(file, 'utf8'), wrong)
})

test('a directory that cannot be written degrades instead of throwing', async () => {
  const result = await loadOrCreateKeys({ dir: '/nonexistent/factotum/push', generate: () => FAKE })

  assert.equal(result.kind, 'unavailable')
})

test('no temporary file is left behind after creating', async () => {
  const push = await dir()
  await loadOrCreateKeys({ dir: push, generate: () => FAKE })
  assert.deepEqual(await readdir(push), [KEYS_FILE])
})

test('the default generator produces keys the shape check accepts', async () => {
  const push = await dir()
  const result = await loadOrCreateKeys({ dir: push })

  assert.equal(result.kind, 'ready')
  assert.equal(result.kind === 'ready' && result.keys.publicKey.length, 87)
  assert.equal(result.kind === 'ready' && result.keys.privateKey.length, 43)
})
