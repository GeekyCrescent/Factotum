import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { createPasswordHealth } from './mail-health.ts'
import { NOW } from './test-state.ts'
import { tempBase } from './test-support.ts'

function file(dir: string, mode: number, content = 'abcd efgh ijkl mnop'): string {
  const path = join(dir, 'gmail-jobs')
  writeFileSync(path, content)
  chmodSync(path, mode)
  return path
}

test('C1 mail health: unknown until the lstat comes back, then ok for a 0600 file', async () => {
  using base = tempBase()
  const health = createPasswordHealth({ file: file(base.dir, 0o600), now: () => NOW })
  assert.deepEqual(health.current(), { state: 'unknown', reason: null, at: null })

  await health.check()

  assert.deepEqual(health.current(), { state: 'ok', reason: null, at: NOW.toISOString() })
})

test('C1 mail health: a 0644 file is «readable by others», without the path', async () => {
  using base = tempBase()
  const path = file(base.dir, 0o644)
  const health = createPasswordHealth({ file: path, now: () => NOW })

  await health.check()

  const current = health.current()
  assert.equal(current.state, 'bad')
  assert.match(current.reason ?? '', /^Mail: password file is readable by others/)
  assert.ok(!(current.reason ?? '').includes(base.dir), 'the reason never carries the path')
})

test('C1 mail health: missing, empty, a symlink and a folder each say so', async () => {
  using base = tempBase()
  const real = file(base.dir, 0o600)
  const link = join(base.dir, 'link')
  symlinkSync(real, link)
  const empty = join(base.dir, 'empty')
  writeFileSync(empty, '')
  chmodSync(empty, 0o600)
  const folder = join(base.dir, 'folder')
  mkdirSync(folder, { mode: 0o700 })
  const cases: readonly (readonly [string, RegExp])[] = [
    [join(base.dir, 'nope'), /is missing/],
    [empty, /is empty/],
    [link, /is a symlink/],
    [folder, /is not a regular file/],
  ]
  for (const [path, reason] of cases) {
    const health = createPasswordHealth({ file: path, now: () => NOW })
    await health.check()
    assert.equal(health.current().state, 'bad', path)
    assert.match(health.current().reason ?? '', reason)
  }
})

test('C1 mail health: the check never reads the content (lstat only)', async () => {
  using base = tempBase()
  const path = file(base.dir, 0o600)
  let reads = 0
  const health = createPasswordHealth({ file: path, now: () => NOW, readPassword: async () => {
    reads += 1
    return { ok: true, password: 'x' }
  } })

  await health.check()

  assert.equal(reads, 0)
})

test('C1 mail health: every real readPassword refreshes the cache with its outcome', async () => {
  using base = tempBase()
  const path = file(base.dir, 0o600)
  let answer: { ok: true; password: string } | { ok: false; reason: string } = { ok: false, reason: 'password file is readable by others (mode 644); chmod 600 it' }
  const health = createPasswordHealth({ file: path, now: () => NOW, readPassword: async () => answer })

  const first = await health.readPassword(path)
  assert.equal(first.ok, false)
  assert.equal(health.current().state, 'bad')
  assert.match(health.current().reason ?? '', /^Mail: password file is readable by others/)

  answer = { ok: true, password: 'secret' }
  assert.deepEqual(await health.readPassword(path), { ok: true, password: 'secret' })
  assert.equal(health.current().state, 'ok')
})

test('C1 mail health: an lstat that throws something odd is bad, never an exception', async () => {
  const health = createPasswordHealth({ file: '/x', now: () => NOW, lstat: async () => {
    throw Object.assign(new Error('boom'), { code: 'EACCES' })
  } })
  await health.check()
  assert.equal(health.current().state, 'bad')
  assert.match(health.current().reason ?? '', /cannot be read \(EACCES\)/)
})
