import assert from 'node:assert/strict'
import { test } from 'node:test'

import { capturedLog } from '../test-support.ts'
import { stopInOrder, type Part } from './lifecycle.ts'

test('C1 stop: a stopper that rejects is logged; the others are still awaited, the store closes after all settled, stop resolves', async () => {
  const captured = capturedLog()
  const order: string[] = []
  let release: () => void = () => undefined
  const slow = new Promise<void>((resolve) => {
    release = resolve
  })
  const part = (name: string, stop: () => Promise<void>): Part => ({ name, stop: async () => (await stop(), void order.push(name)) })
  const stages: readonly (readonly Part[])[] = [
    [part('clock', async () => undefined)],
    [
      { name: 'checks', stop: async () => Promise.reject(new Error('boom')) },
      part('queue', () => slow),
      part('sender', async () => undefined),
    ],
  ]

  const stopping = stopInOrder(stages, () => void order.push('close'), captured.log)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(!order.includes('close'), 'the store waits for the queue')
  release()
  await stopping

  assert.deepEqual(order, ['clock', 'sender', 'queue', 'close'])
  assert.deepEqual(captured.lines, ['error jobs: checks did not stop cleanly (boom)'])
})

test('C1 stop: a later stage waits for the earlier one; a close that throws is logged, never thrown', async () => {
  const captured = capturedLog()
  const order: string[] = []
  const stages: readonly (readonly Part[])[] = [
    [{ name: 'imports', stop: async () => void order.push('imports') }],
    [{ name: 'clock', stop: async () => void order.push('clock') }],
  ]

  await stopInOrder(
    stages,
    () => {
      throw new Error('locked')
    },
    captured.log,
  )

  assert.deepEqual(order, ['imports', 'clock'])
  assert.deepEqual(captured.lines, ['error jobs: jobs.db did not close cleanly (locked)'])
})
