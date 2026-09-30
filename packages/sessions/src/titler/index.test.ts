import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Timers } from '@factotum/core'
import { uuidv7 } from '../id.ts'
import { sessionPaths } from '../paths.ts'
import { SessionStore, type SessionMeta } from '../store.ts'
import type { TitlesConfig } from '../types.ts'
import { createTitler, killQuietly, type TitlerDeps } from './index.ts'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'fake-claude.mjs')
const ON: TitlesConfig = { enabled: true, model: 'haiku', effort: 'low' }

const timers: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    handle.unref()
    return { [Symbol.dispose]: () => clearInterval(handle) }
  },
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref()
    return { [Symbol.dispose]: () => clearTimeout(handle) }
  },
}

/** Poll, do not guess a delay (CLAUDE.md §7). */
async function eventually(check: () => Promise<boolean> | boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

interface Calls {
  readonly owner: string
  readonly pid: number
}

interface Rig {
  readonly deps: TitlerDeps
  readonly written: { id: string; title: string }[]
  readonly infos: string[]
  readonly warns: string[]
  readonly calls: () => Promise<readonly Calls[]>
}

async function rig(overrides: Partial<TitlerDeps> = {}): Promise<Rig> {
  const cwd = await mkdtemp(join(tmpdir(), 'factotum-titler-'))
  const written: { id: string; title: string }[] = []
  const infos: string[] = []
  const warns: string[] = []
  const deps: TitlerDeps = {
    config: ON,
    cwd,
    timers,
    log: { info: (m) => void infos.push(m), warn: (m) => void warns.push(m), error: (m) => void warns.push(m) },
    write: async (id, title) => {
      written.push({ id, title })
      return { id } as SessionMeta
    },
    bin: FAKE,
    ...overrides,
  }
  const calls = async (): Promise<readonly Calls[]> => {
    try {
      const text = await readFile(join(cwd, 'titler-calls.log'), 'utf8')
      return text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Calls)
    } catch {
      return []
    }
  }
  return { deps, written, infos, warns, calls }
}

/** Fails the test if anything escapes as an unhandled rejection or an uncaught exception (crit. 9). */
function trapEscapes(): { readonly escaped: unknown[]; readonly release: () => void } {
  const escaped: unknown[] = []
  const onRejection = (reason: unknown) => void escaped.push(reason)
  const onException = (error: unknown) => void escaped.push(error)
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)
  return {
    escaped,
    release: () => {
      process.off('unhandledRejection', onRejection)
      process.off('uncaughtException', onException)
    },
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const ID = '01a0eb02-9104-7cc7-bafc-259cf61fb313'

test('a message that says what it is about gets its title written (criterion 1)', async () => {
  const { deps, written, infos } = await rig()
  createTitler(deps).start(ID, 'title:ok')
  await eventually(() => written.length === 1, 'the title written')
  assert.deepEqual(written, [{ id: ID, title: 'Plan de maratón' }])
  await eventually(() => infos.some((m) => /titled in \d+ ms: Plan de maratón/.test(m)), 'the timing line')
})

test('NO TITLE writes nothing, and says so as info, not as a warning (criterion 4)', async () => {
  const { deps, written, infos, warns } = await rig()
  createTitler(deps).start(ID, 'title:none')
  await eventually(() => infos.some((m) => m.includes('no title')), 'the no-title line')
  assert.deepEqual(written, [])
  assert.deepEqual(warns, [])
})

test('a CLI that fails leaves a warning with its stderr, writes nothing, and is not retried (criteria 8, 10)', async () => {
  const { deps, written, warns, calls } = await rig()
  createTitler(deps).start(ID, 'title:boom')
  await eventually(() => warns.length === 1, 'the warning')
  assert.match(warns[0]!, /code 1/)
  assert.match(warns[0]!, /the titler broke/)
  assert.deepEqual(written, [])
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal((await calls()).length, 1)
})

test('a titler that does not answer is killed at the deadline, writes nothing (criterion 7)', async () => {
  const { deps, written, warns, calls } = await rig({ timeoutMs: 200 })
  createTitler(deps).start(ID, 'title:hang')
  await eventually(async () => (await calls()).length === 1, 'the titler started')
  const [call] = await calls()
  await eventually(() => warns.some((m) => m.includes('gave up')), 'the timeout warning')
  await eventually(() => !alive(call!.pid), 'the titler process gone')
  assert.deepEqual(written, [])
})

test('off, or with no text, the titler is never started (criteria 6, 16)', async () => {
  const off = await rig({ config: { ...ON, enabled: false } })
  createTitler(off.deps).start(ID, 'title:ok')
  const blank = await rig()
  createTitler(blank.deps).start(ID, '   \n ')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(await off.calls(), [])
  assert.deepEqual(await blank.calls(), [])
})

test('the conversation deleted while it is titled: nothing is made again, nothing thrown (criterion 11)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factotum-titler-store-'))
  const paths = sessionPaths(root)
  const store = new SessionStore(paths, () => new Date())
  await store.ensureRoots()
  const id = uuidv7(Date.now())
  await store.create({ id, siteId: 'work', entryId: 'free', startedAt: new Date().toISOString(), sitePath: '/w', prompt: 'x' })
  await store.patchMeta(id, (meta) => ({ ...meta, state: 'finished' }))

  const guard = trapEscapes()
  const { deps, infos } = await rig({
    write: async (sessionId, title) =>
      await store.patchMeta(sessionId, (meta) => (meta.autoTitle !== undefined ? meta : { ...meta, autoTitle: title })),
  })
  createTitler(deps).start(id, 'title:slow:300')
  assert.equal(await store.remove(id, () => false), 'removed')

  await eventually(() => infos.some((m) => m.includes('deleted before its title')), 'the deleted line')
  await assert.rejects(stat(paths.sessionDir(id)))
  guard.release()
  assert.deepEqual(guard.escaped, [])
})

test('NOTHING ESCAPES: a write that rejects, a spawn that throws, a missing binary, stop twice (criterion 9)', async () => {
  const guard = trapEscapes()

  // A write that rejects.
  const rejecting = await rig({
    write: async () => {
      throw new Error('disk full')
    },
  })
  createTitler(rejecting.deps).start(ID, 'title:ok')
  await eventually(() => rejecting.warns.some((m) => m.includes('disk full')), 'the rejected write reported')

  // A spawn that throws SYNCHRONOUSLY: Node refuses an argument holding a NUL.
  const throwing = await rig()
  assert.doesNotThrow(() => createTitler(throwing.deps).start(ID, 'a\u0000b'))
  assert.equal(throwing.warns.length, 1)

  // A binary that is not there: `error` AND `close` both arrive, and decide ONCE.
  const missing = await rig({ bin: '/nonexistent/claude' })
  createTitler(missing.deps).start(ID, 'title:ok')
  await eventually(() => missing.warns.length >= 1, 'the missing binary reported')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(missing.warns.length, 1, missing.warns.join('\n'))

  // Stopped twice, with nothing in flight the second time.
  const twice = createTitler((await rig()).deps)
  assert.doesNotThrow(() => {
    twice.stop()
    twice.stop()
  })

  await new Promise((resolve) => setTimeout(resolve, 100))
  guard.release()
  assert.deepEqual(guard.escaped, [])
})

test('killing a group that is already gone, or no pid at all, is quiet (criterion 9)', () => {
  assert.doesNotThrow(() => killQuietly(undefined))
  // A pid no process has: `process.kill(-pid)` throws ESRCH, and this must not.
  assert.doesNotThrow(() => killQuietly(2 ** 22 - 3))
})

test('stop() kills a titler in flight, and nothing is written after (criterion 12)', async () => {
  const { deps, written, calls } = await rig()
  const titler = createTitler(deps)
  titler.start(ID, 'title:hang')
  await eventually(async () => (await calls()).length === 1, 'the titler started')
  const [call] = await calls()
  titler.stop()
  // `stop` does not wait for the group to die, so this polls (CLAUDE.md §7).
  await eventually(() => !alive(call!.pid), 'the titler process gone')
  assert.deepEqual(written, [])
})

test('after stop(), start() starts nothing', async () => {
  const { deps, calls } = await rig()
  const titler = createTitler(deps)
  titler.stop()
  titler.start(ID, 'title:ok')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(await calls(), [])
})
