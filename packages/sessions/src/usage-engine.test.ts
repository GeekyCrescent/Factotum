import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Timers } from '@factotum/core'
import { createEngine } from './engine.ts'
import { uuidv7 } from './id.ts'
import { sessionPaths } from './paths.ts'
import { SessionStore } from './store.ts'
import { memoryRegistry } from './test-registry.ts'
import type { EventInput, SessionEngine, UsageCount } from './types.ts'

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

const NOW = Date.parse('2026-10-05T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const LIST = { skills: ['create-spec'], agents: ['spec-validator'], commands: ['clear'], version: '2.0.0', since: '2026-10-01T00:00:00.000Z' }

interface Seed {
  /** Days before NOW the session started. */
  readonly daysAgo: number
  readonly agent?: string
  readonly entryId?: string
  readonly archived?: boolean
  readonly events: readonly EventInput[]
}

async function world(seeds: readonly Seed[], list: object | null = LIST): Promise<{ engine: SessionEngine; stateDir: string; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factotum-usage-')))
  const stateDir = join(root, 'state')
  await mkdir(join(root, 'a'), { recursive: true })
  const paths = sessionPaths(stateDir)
  const store = new SessionStore(paths, () => new Date(NOW))
  await store.ensureRoots()
  if (list !== null) await writeFile(paths.announcedFile, JSON.stringify(list))
  let seq = 0
  for (const seed of seeds) {
    const startedAt = NOW - seed.daysAgo * DAY
    const id = uuidv7(startedAt + seq++)
    await store.create({ id, siteId: 'a', entryId: seed.entryId ?? 'free', startedAt: new Date(startedAt).toISOString(), sitePath: undefined, agent: seed.agent, prompt: undefined })
    // The clock of an event is the store's: this one stands at the start of its session.
    for (const event of seed.events) await store.append(id, event)
    const endedAt = new Date(startedAt + 1000).toISOString()
    await store.patchMeta(id, (m) => ({ ...m, state: 'finished', endedAt, archivedAt: seed.archived === true ? 'x' : undefined }))
  }
  const engine = await createEngine({
    titles: { enabled: false, model: 'haiku', effort: 'low' },
    stateDir,
    registry: memoryRegistry({ sites: [{ id: 'a', path: join(root, 'a') }] }),
    home: join(root, 'home'),
    factotumRoot: join(root, 'home', '.factotum'),
    installRoot: undefined,
    catalog: [
      { id: 'free', label: 'Free', invoke: { kind: 'none' } },
      { id: 'spec', label: 'Spec', invoke: { kind: 'command', name: 'create-spec' } },
    ],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(NOW),
    timers,
    hookUrl: () => 'http://127.0.0.1:1',
    notify: { canReach: () => false, send: async () => undefined },
  })
  await engine.reconcile()
  return { engine, stateDir, root }
}

const say = (text: string): EventInput => ({ kind: 'message', role: 'user', text })
const byName = (counts: readonly UsageCount[] | undefined, name: string) => counts?.find((c) => c.name === name)

test('without an announced list there is nothing to count', async () => {
  const { engine } = await world([], null)
  assert.equal(await engine.usage(30), undefined)
})

test('every announced name comes back, zeros included, in skills, agents, commands order', async () => {
  const { engine } = await world([])
  assert.deepEqual(await engine.usage(30), [
    { name: 'create-spec', owner: 0, agent: 0, lastUsedAt: undefined },
    { name: 'spec-validator', owner: 0, agent: 0, lastUsedAt: undefined },
    { name: 'clear', owner: 0, agent: 0, lastUsedAt: undefined },
  ])
})

test('it sums owner and agent uses over the sessions, built-in commands included', async () => {
  const { engine } = await world([
    { daysAgo: 1, events: [say('/create-spec a'), say('/clear'), { kind: 'tool', name: 'Skill', input: { skill: 'create-spec' } }] },
    { daysAgo: 2, agent: 'spec-validator', entryId: 'spec', events: [] },
  ])
  const counts = await engine.usage(30)
  assert.equal(byName(counts, 'create-spec')?.owner, 2, 'typed once, launched through the command entry once')
  assert.equal(byName(counts, 'create-spec')?.agent, 1)
  assert.equal(byName(counts, 'spec-validator')?.owner, 1)
  assert.equal(byName(counts, 'clear')?.owner, 1)
  assert.ok((byName(counts, 'create-spec')?.lastUsedAt ?? '') >= new Date(NOW - 1 * DAY).toISOString())
})

test('a session older than the period is not counted; an archived one inside it is', async () => {
  const { engine } = await world([
    { daysAgo: 40, events: [say('/create-spec old')] },
    { daysAgo: 3, archived: true, events: [say('/create-spec archived')] },
  ])
  assert.equal(byName(await engine.usage(30), 'create-spec')?.owner, 1)
  assert.equal(byName(await engine.usage(90), 'create-spec')?.owner, 2)
})
