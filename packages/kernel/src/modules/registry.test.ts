import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnyModule, ModuleContext, NotificationMessage } from '@factotum/core'
import type { ComposedModule } from '../config/load.ts'
import { statePaths } from '../config/paths.ts'
import { Registry } from './registry.ts'

/** What the registry was asked to send, and on behalf of whom. */
interface SentNotice {
  readonly message: NotificationMessage
  readonly moduleId: string | null
}

function fakePush(reachable = false) {
  const sent: SentNotice[] = []
  return {
    sent,
    canReach: () => reachable,
    send: async (message: NotificationMessage, moduleId: string | null) => {
      sent.push({ message, moduleId })
    },
  }
}

async function deps(startTimeoutMs = 50, push = fakePush()) {
  const home = await mkdtemp(join(tmpdir(), 'factotum-'))
  return { paths: statePaths('prod', home), env: 'prod' as const, startTimeoutMs, push }
}

const enabled = (module: AnyModule, config: unknown = undefined): ComposedModule => ({
  module,
  status: { kind: 'enabled' },
  config,
})

const disabled = (module: AnyModule, reason: string): ComposedModule => ({
  module,
  status: { kind: 'disabled', reason },
  config: undefined,
})

const query = new URLSearchParams()

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

test('an enabled module answers on its own routes', async () => {
  const registry = await Registry.create(
    [enabled({ id: 'example', routes: () => ({ 'GET /ping': () => ({ status: 200, body: 'pong' }) }) })],
    await deps(),
  )

  assert.deepEqual(await registry.dispatch('example', 'GET', '/ping', query, undefined), {
    status: 200,
    body: 'pong',
  })
})

test('a module that was never registered is simply absent', async () => {
  // Which is what OFF looks like: the caller turns `undefined` into a 404.
  const registry = await Registry.create([], await deps())
  assert.equal(await registry.dispatch('nope', 'GET', '/x', query, undefined), undefined)
})

test('an unknown route inside a known module is a 404', async () => {
  const registry = await Registry.create(
    [enabled({ id: 'example', routes: () => ({ 'GET /ping': () => ({ status: 200 }) }) })],
    await deps(),
  )
  const response = await registry.dispatch('example', 'GET', '/other', query, undefined)
  assert.equal(response?.status, 404)
})

// ---------------------------------------------------------------------------
// Disabled: the kernel serves the 501 itself
// ---------------------------------------------------------------------------

test('a disabled module answers 501 with the reason, served by the kernel', async () => {
  // It has no context — its config never parsed — so there is no route table to ask
  // it for. The stub is the only way this can work.
  const registry = await Registry.create(
    [disabled({ id: 'broken', routes: () => ({ 'GET /x': () => ({ status: 200 }) }) }, 'config `modules.broken.key`: expected string')],
    await deps(),
  )

  const response = await registry.dispatch('broken', 'GET', '/anything', query, undefined)
  assert.equal(response?.status, 501)
  assert.match(JSON.stringify(response?.body), /expected string/)
})

test('a disabled module is listed with its reason for doctor and the client', async () => {
  const registry = await Registry.create(
    [disabled({ id: 'broken', nav: { label: 'Broken', icon: 'x' } }, 'no api key')],
    await deps(),
  )
  const [summary] = registry.list()
  assert.equal(summary?.status.kind, 'disabled')
  assert.equal(summary?.nav?.label, 'Broken')
})

// ---------------------------------------------------------------------------
// start(): throwing, hanging, and what survives
// ---------------------------------------------------------------------------

test('a module whose start throws is disabled and the rest keep running', async () => {
  const registry = await Registry.create(
    [
      enabled({ id: 'bad', start: () => { throw new Error('no api key at /nope') } }),
      enabled({ id: 'good', routes: () => ({ 'GET /ping': () => ({ status: 200 }) }) }),
    ],
    await deps(),
  )

  await registry.startAll()

  const bad = registry.list().find((m) => m.id === 'bad')
  assert.equal(bad?.status.kind, 'disabled')
  assert.match(bad?.status.kind === 'disabled' ? bad.status.reason : '', /no api key/)

  // The point of degrading: one bad credential path cannot leave its owner with nothing.
  assert.equal((await registry.dispatch('good', 'GET', '/ping', query, undefined))?.status, 200)
})

test('a module whose start hangs is disabled by timeout and the daemon proceeds', async () => {
  // Without the bound, the readiness flag turns "one route answers badly" into
  // "nothing answers, forever".
  const registry = await Registry.create(
    [enabled({ id: 'hangs', start: () => new Promise(() => {}) })],
    await deps(30),
  )

  await registry.startAll()

  const entry = registry.list()[0]
  assert.equal(entry?.status.kind, 'disabled')
  assert.match(entry?.status.kind === 'disabled' ? entry.status.reason : '', /did not finish within/)
})

test('a timer armed before start threw does not survive', async () => {
  // The leak this ownership exists to prevent: no ModuleHandle was ever returned,
  // so nothing else could clear it and the process would never exit.
  let ticks = 0
  const registry = await Registry.create(
    [
      enabled({
        id: 'leaky',
        start: (ctx: ModuleContext) => {
          ctx.timers.setInterval(() => { ticks += 1 }, 1)
          throw new Error('and then it failed')
        },
      }),
    ],
    await deps(),
  )

  await registry.startAll()
  const after = ticks
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(ticks, after, 'the interval should have been disposed')
})

test('stopping calls every handle and disposes every timer', async () => {
  const stopped: string[] = []
  let ticks = 0

  const registry = await Registry.create(
    [
      enabled({ id: 'first', start: () => ({ stop: () => void stopped.push('first') }) }),
      enabled({
        id: 'second',
        start: (ctx: ModuleContext) => {
          ctx.timers.setInterval(() => { ticks += 1 }, 1)
          return { stop: () => void stopped.push('second') }
        },
      }),
    ],
    await deps(),
  )

  await registry.startAll()
  await registry.stopAll()

  // Reverse order, so a module can rely on the ones it was started after.
  assert.deepEqual(stopped, ['second', 'first'])

  const after = ticks
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(ticks, after)
})

test('a module that throws on the way down does not block the others', async () => {
  const stopped: string[] = []
  const registry = await Registry.create(
    [
      enabled({ id: 'first', start: () => ({ stop: () => void stopped.push('first') }) }),
      enabled({ id: 'rude', start: () => ({ stop: () => { throw new Error('no') } }) }),
    ],
    await deps(),
  )

  await registry.startAll()
  await registry.stopAll()
  assert.deepEqual(stopped, ['first'])
})

test('a module with no start is left alone', async () => {
  const registry = await Registry.create([enabled({ id: 'quiet' })], await deps())
  await registry.startAll()
  assert.equal(registry.list()[0]?.status.kind, 'enabled')
  await registry.stopAll()
})

// ---------------------------------------------------------------------------
// notify — the seventh field
// ---------------------------------------------------------------------------

test('ModuleContext has EXACTLY seven keys, spelled out by hand (criterion 36)', async () => {
  // A diff saying "only that block changed" discriminates nothing. A count does: an eighth
  // field turns this red, and so does one quietly dropped. Same mechanism, and the same
  // reason, as the EngineSetup key list in the session module's own server test.
  let seen: ModuleContext | undefined
  await Registry.create(
    [enabled({ id: 'probe', routes: (ctx) => ((seen = ctx), {}) })],
    await deps(),
  )

  assert.deepEqual(Object.keys(seen ?? {}).sort(), ['config', 'env', 'log', 'notify', 'now', 'stateDir', 'timers'])
})

test('a module notifies AS ITSELF: the registry binds the id, the module cannot pass one', async () => {
  const push = fakePush(true)
  let seen: ModuleContext | undefined
  await Registry.create([enabled({ id: 'probe', routes: (ctx) => ((seen = ctx), {}) })], await deps(50, push))

  const message = { title: 't', body: 'b', path: '/', tag: 'x' }
  // Even a module that tries to smuggle an id in has no parameter to put it in.
  await (seen?.notify.send as unknown as (m: unknown, id: string) => Promise<void>)(message, 'someone-else')

  assert.deepEqual(push.sent, [{ message, moduleId: 'probe' }])
})

test('two modules get two distinct identities from the same push service', async () => {
  const push = fakePush(true)
  const seen = new Map<string, ModuleContext>()
  await Registry.create(
    [
      enabled({ id: 'one', routes: (ctx) => (seen.set('one', ctx), {}) }),
      enabled({ id: 'two', routes: (ctx) => (seen.set('two', ctx), {}) }),
    ],
    await deps(50, push),
  )

  const message = { title: 't', body: 'b', path: '/', tag: 'x' }
  await seen.get('two')?.notify.send(message)
  await seen.get('one')?.notify.send(message)

  assert.deepEqual(push.sent.map((s) => s.moduleId), ['two', 'one'])
})

test('canReach is the push service answering, not a value frozen at composition', async () => {
  let reachable = false
  const push = { ...fakePush(), canReach: () => reachable }
  let seen: ModuleContext | undefined
  await Registry.create([enabled({ id: 'probe', routes: (ctx) => ((seen = ctx), {}) })], await deps(50, push))

  assert.equal(seen?.notify.canReach(), false)
  reachable = true // a device subscribed after boot
  assert.equal(seen?.notify.canReach(), true)
})
