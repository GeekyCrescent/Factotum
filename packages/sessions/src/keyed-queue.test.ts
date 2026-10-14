import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeyedQueue } from './keyed-queue.ts'
import { SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'

test('tasks on one key run one after the other, in order', async () => {
  const queue = new KeyedQueue()
  const seen: string[] = []
  const slow = queue.run('a', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    seen.push('first')
  })
  const fast = queue.run('a', async () => void seen.push('second'))
  await Promise.all([slow, fast])
  assert.deepEqual(seen, ['first', 'second'])
})

test('two keys do not wait for each other', async () => {
  const queue = new KeyedQueue()
  const seen: string[] = []
  let release = () => {}
  const blocked = queue.run('a', () => new Promise<void>((resolve) => (release = resolve)))
  await queue.run('b', async () => void seen.push('b'))
  assert.deepEqual(seen, ['b'])
  release()
  await blocked
})

test('a rejected task does not poison the next one, and the key is forgotten once its queue is empty', async () => {
  const queue = new KeyedQueue()
  await assert.rejects(queue.run('a', async () => { throw new Error('disk') }))
  assert.equal(await queue.run('a', async () => 'after'), 'after')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(queue.size, 0)
})

test('a task of another queue that calls locks.release of the same site ends (design D9)', async () => {
  const paths = sessionPaths(await mkdtemp(join(tmpdir(), 'factotum-kq-')))
  const locks = new SiteLocks(paths)
  const handoff = new KeyedQueue()
  assert.deepEqual(await locks.acquire('vault', 'handoff-x', 'now'), { ok: true })
  // Inside the handoff's own queue, keyed by the same site: release goes through the LOCKS' queue.
  await handoff.run('vault', async () => await locks.release('vault', 'handoff-x'))
  assert.equal(await locks.heldBy('vault'), undefined)
})
