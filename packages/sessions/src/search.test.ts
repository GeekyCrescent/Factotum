import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Timers } from '@factotum/core'
import { createEngine } from './engine.ts'
import { uuidv7 } from './id.ts'
import { sessionPaths } from './paths.ts'
import { SEARCH_LIMIT, snippetOf } from './search.ts'
import { SessionStore } from './store.ts'
import { memoryRegistry } from './test-registry.ts'
import type { EventInput, SessionEngine } from './types.ts'

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

interface Seed {
  readonly site: string
  readonly prompt?: string
  readonly title?: string
  readonly archived?: boolean
  readonly events: readonly EventInput[]
}

const say = (text: string, role: 'user' | 'assistant' = 'assistant'): EventInput => ({ kind: 'message', role, text })

/** An engine over `a` and `b` (and `gone`, whose folder is not there), with these conversations. */
async function world(seeds: readonly Seed[]): Promise<{ engine: SessionEngine; ids: string[]; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factotum-search-')))
  const stateDir = join(root, 'state')
  for (const site of ['a', 'b']) await mkdir(join(root, site), { recursive: true })
  const store = new SessionStore(sessionPaths(stateDir), () => new Date())
  await store.ensureRoots()
  const ids: string[] = []
  let at = Date.parse('2026-09-01T00:00:00.000Z')
  for (const seed of seeds) {
    at += 1000
    const id = uuidv7(at)
    ids.push(id)
    await store.create({ id, siteId: seed.site, entryId: 'free', startedAt: new Date(at).toISOString(), sitePath: undefined, agent: undefined, prompt: seed.prompt })
    for (const event of seed.events) await store.append(id, event)
    await store.patchMeta(id, (m) => ({ ...m, state: 'finished', title: seed.title, archivedAt: seed.archived === true ? 'x' : undefined }))
  }
  const registry = memoryRegistry({
    sites: [
      { id: 'a', path: join(root, 'a') },
      { id: 'b', path: join(root, 'b') },
      { id: 'gone', path: join(root, 'gone') },
    ],
  })
  await registry.update(async () => ({ kind: 'set-project', id: 'b', name: 'Beta Garden', color: 2 }))
  const engine = await createEngine({
    titles: { enabled: false, model: 'haiku', effort: 'low' },
    stateDir,
    registry,
    home: join(root, 'home'),
    factotumRoot: join(root, 'home', '.factotum'),
    installRoot: undefined,
    catalog: [],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(),
    timers,
    hookUrl: () => 'http://127.0.0.1:1',
    notify: { canReach: () => false, send: async () => undefined },
  })
  await engine.reconcile()
  return { engine, ids, root }
}

test('the phrase is 60 characters each side, on one line, with an ellipsis where it was cut (criterion 38)', () => {
  const text = `${'a'.repeat(100)}\nNEEDLE\n${'b'.repeat(100)}`
  const snippet = snippetOf(text, 101, 6)
  assert.equal(snippet, `…${'a'.repeat(59)} NEEDLE ${'b'.repeat(59)}…`)
  assert.equal(snippetOf('short needle here', 6, 6), 'short needle here')
})

test('IN THE MESSAGES, ignoring case, with the phrase; the first match per conversation (criterion 38)', async () => {
  const { engine, ids } = await world([
    { site: 'a', prompt: 'start', events: [say('We refactor the PARSER today'), say('the parser again')] },
    { site: 'a', prompt: 'other', events: [say('nothing here')] },
  ])
  const hits = await engine.search('parser')
  assert.deepEqual(hits.map((h) => h.summary.id), [ids[0]])
  assert.equal(hits[0]?.snippet, 'We refactor the PARSER today')
})

test('ONLY MESSAGES: a tool input or result with the word is not a match (criterion 38)', async () => {
  const { engine } = await world([
    {
      site: 'a',
      prompt: 'x',
      events: [
        { kind: 'tool', name: 'Write', input: { content: 'secret-word' } },
        { kind: 'result', name: 'Write', ok: true, summary: 'wrote secret-word' },
      ],
    },
  ])
  assert.deepEqual(await engine.search('secret-word'), [])
})

test('TITLES, PROMPTS AND PROJECTS match too, with no phrase; archived ones are found', async () => {
  const { engine, ids } = await world([
    { site: 'a', prompt: 'deploy the api', events: [] },
    { site: 'a', prompt: 'x', title: 'Tax return', archived: true, events: [] },
    { site: 'b', prompt: 'y', events: [] },
  ])
  assert.deepEqual((await engine.search('DEPLOY')).map((h) => [h.summary.id, h.snippet]), [[ids[0], undefined]])
  assert.deepEqual((await engine.search('tax')).map((h) => [h.summary.id, h.summary.archived]), [[ids[1], true]])
  assert.deepEqual((await engine.search('garden')).map((h) => h.summary.id), [ids[2]], 'by the project’s name')
})

test('NOT IN A MISSING PROJECT, nor a removed one (criteria 25, 28)', async () => {
  const { engine, root } = await world([
    { site: 'gone', prompt: 'needle', events: [say('needle')] },
    { site: 'demo', prompt: 'needle', events: [say('needle')] },
    { site: 'b', prompt: 'x', events: [say('needle')] },
  ])
  const hits = await engine.search('needle')
  assert.deepEqual(hits.map((h) => h.summary.siteId), ['b'])
  await rename(join(root, 'b'), join(root, 'b-moved'))
  assert.deepEqual(await engine.search('needle'), [])
})

test(`AT MOST ${SEARCH_LIMIT}, newest first; fewer than two characters finds nothing (criterion 38)`, async () => {
  const seeds: Seed[] = Array.from({ length: SEARCH_LIMIT + 5 }, (_, i) => ({ site: 'a', prompt: `p${i}`, events: [say('common words')] }))
  const { engine, ids } = await world(seeds)
  const hits = await engine.search('common')
  assert.equal(hits.length, SEARCH_LIMIT)
  assert.equal(hits[0]?.summary.id, ids.at(-1))
  assert.deepEqual(await engine.search(' c '), [])
})
