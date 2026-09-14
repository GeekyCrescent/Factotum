import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModuleContext, Timers } from '@factotum/core'
import { exampleConfigSchema, type ExampleConfig } from './config.ts'
import { exampleModule } from './server.ts'

/** Timers a test can advance, which is why the contract injects them at all. */
function fakeTimers(): { timers: Timers; tick: () => void } {
  let fn: (() => void) | undefined
  return {
    timers: {
      setInterval: (callback) => {
        fn = callback
        return { [Symbol.dispose]: () => { fn = undefined } }
      },
      setTimeout: () => ({ [Symbol.dispose]: () => undefined }),
    },
    tick: () => fn?.(),
  }
}

/**
 * The tick persists asynchronously and the writes are chained, so a test cannot assume
 * anything has landed by the next microtask — not even that the file EXISTS yet.
 * Polling is honest about that; `setImmediate` only looked deterministic until
 * coverage instrumentation shifted the timing.
 */
async function eventually<T>(read: () => Promise<T>, want: (value: T) => boolean): Promise<T> {
  // Ten seconds, not two. Polling costs nothing when it passes — the loop exits on
  // the first check — and only spends the budget on a run that was going to fail
  // anyway. Two seconds flaked once under the load of the whole workspace testing in
  // parallel with coverage instrumentation, which is not a failure worth reporting.
  const deadline = Date.now() + 10_000
  let last: unknown = 'nothing read yet'
  for (;;) {
    try {
      const value = await read()
      last = value
      if (want(value)) return value
    } catch (error) {
      // A READ THAT THROWS IS "NOT YET", NOT A FAILURE. The first poll can easily
      // arrive before the first write has created the file at all, and treating that
      // as fatal turns a timing question into an ENOENT.
      last = String(error)
    }
    if (Date.now() > deadline) {
      assert.fail(`condition never became true; last value ${JSON.stringify(last)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function context(over: Partial<ExampleConfig> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'factotum-example-'))
  const { timers, tick } = fakeTimers()
  const ctx: ModuleContext<ExampleConfig> = {
    config: exampleConfigSchema.parse(over),
    stateDir,
    env: 'prod',
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    timers,
  }
  return { ctx, tick, stateDir }
}

test('the fragment has a default for every field', () => {
  // A module that needs configuration in order to start is badly designed.
  assert.deepEqual(exampleConfigSchema.parse({}), {
    greeting: 'hello from factotum',
    tickSeconds: 30,
  })
})

test('a tick interval outside the bounds is refused', () => {
  assert.equal(exampleConfigSchema.safeParse({ tickSeconds: 0 }).success, false)
  assert.equal(exampleConfigSchema.safeParse({ tickSeconds: 99_999 }).success, false)
})

test('ping answers with the configured greeting', async () => {
  const { ctx } = await context({ greeting: 'hola' })
  const response = await exampleModule.routes!(ctx)['GET /ping']!({
    method: 'GET', path: '/ping', params: {}, query: {}, body: undefined,
  })
  assert.equal(response.status, 200)
  assert.equal((response.body as { greeting: string }).greeting, 'hola')
})

test('the background task counts, persists, and stops when told', async () => {
  // The part of the contract that is easiest to leave untested, which is why the
  // reference module has one at all.
  const { ctx, tick, stateDir } = await context({ tickSeconds: 1 })
  const handle = await exampleModule.start!(ctx)

  const ticksOnDisk = async () =>
    JSON.parse(await readFile(join(stateDir, 'ticks.json'), 'utf8')) as { ticks: number }

  tick()
  tick()
  await eventually(ticksOnDisk, (state) => state.ticks === 2)

  await handle.stop()
  tick() // disposed: this must not count
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal((await ticksOnDisk()).ticks, 2)
})

test('ping reports the ticks the background task recorded', async () => {
  const { ctx, tick } = await context({ tickSeconds: 1 })
  const handle = await exampleModule.start!(ctx)
  tick()

  const body = await eventually(
    async () =>
      (
        await exampleModule.routes!(ctx)['GET /ping']!({
          method: 'GET', path: '/ping', params: {}, query: {}, body: undefined,
        })
      ).body as { ticks: number },
    (value) => value.ticks === 1,
  )
  assert.equal(body.ticks, 1)
  await handle.stop()
})
