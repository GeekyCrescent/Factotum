import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UsageCount } from '../types.ts'
import type { NotesRead } from './notes.ts'
import { skillsRoutes, type SkillsDeps } from './routes.ts'

const deps = (over: Partial<SkillsDeps> = {}): SkillsDeps => ({
  announced: () => ({ skills: ['alpha'], agents: [], commands: [], version: undefined, since: '2026-10-03T00:00:00.000Z' }),
  pinnedOf: (site) => (site === 'proj' ? ['alpha'] : []),
  notes: { read: async () => ({ state: 'off' }) },
  usage: async () => [],
  ...over,
})

const get = async (current: SkillsDeps | undefined, query: Record<string, string> = {}) =>
  await skillsRoutes(() => current)['GET /skills']!({ method: 'GET', path: '/skills', params: {}, query, body: undefined })

test('before start() it answers 503, not a guess', async () => {
  assert.equal((await get(undefined)).status, 503)
})

test('it answers 200 no-store with the arranged view', async () => {
  const response = await get(deps())
  assert.equal(response.status, 200)
  assert.deepEqual(response.headers, { 'cache-control': 'no-store' })
  assert.equal((response.body as { groups: unknown[] }).groups.length, 1)
})

test('the site query selects the pins; an unknown or empty one has none', async () => {
  const labels = async (query: Record<string, string>) =>
    ((await get(deps(), query)).body as { groups: { label: string }[] }).groups.map((group) => group.label)
  assert.deepEqual(await labels({ site: 'proj' }), ['Pinned'])
  assert.deepEqual(await labels({ site: 'nope' }), ['Unsorted'])
  assert.deepEqual(await labels({ site: '' }), ['Unsorted'])
  assert.deepEqual(await labels({}), ['Unsorted'])
})

// --- GET /skills/usage (D9) ---

const LIST = { skills: ['alpha', 'unused-skill'], agents: ['helper'], commands: ['deploy', 'clear'], version: undefined, since: '2026-10-03T00:00:00.000Z' }
const count = (name: string, owner = 0, agent = 0): UsageCount => ({ name, owner, agent, lastUsedAt: undefined })
/** What the engine returns: a count for EVERY announced name, built-in commands included. */
const ALL = [count('alpha', 2), count('unused-skill'), count('helper', 0, 1), count('deploy', 1), count('clear', 5)]
const NOTE: NotesRead = {
  state: 'ok',
  parsed: { groups: [{ label: 'Ship', rows: [{ name: 'deploy', agent: false, why: undefined, when: undefined }] }], warnings: [] },
}

const usage = async (current: SkillsDeps | undefined, query: Record<string, string> = {}) =>
  await skillsRoutes(() => current)['GET /skills/usage']!({ method: 'GET', path: '/skills/usage', params: {}, query, body: undefined })

test('usage: before start() it answers 503', async () => {
  assert.equal((await usage(undefined)).status, 503)
})

test('usage: without a list it is 200 with an unknown list and no counts, and the engine is not asked', async () => {
  const response = await usage(deps({ announced: () => undefined, usage: async () => assert.fail('no list, nothing to count') }))
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { list: { state: 'unknown' }, counts: [] })
})

test('usage: a list the engine cannot count either is the same unknown answer', async () => {
  const response = await usage(deps({ announced: () => LIST, usage: async () => undefined }))
  assert.deepEqual(response.body, { list: { state: 'unknown' }, counts: [] })
})

test('usage: 30 days by default, and the days asked for reach the engine', async () => {
  const asked: number[] = []
  const current = deps({ announced: () => LIST, usage: async (days) => (asked.push(days), []) })
  await usage(current)
  await usage(current, { days: '7' })
  await usage(current, { days: '1' })
  await usage(current, { days: '90' })
  assert.deepEqual(asked, [30, 7, 1, 90])
})

test('usage: days outside 1..90 or not a whole number is 400', async () => {
  const current = deps({ announced: () => LIST, usage: async () => assert.fail('a bad request is not counted') })
  for (const days of ['0', '91', '-3', '1.5', 'abc', '', '7days', '1e1']) {
    const response = await usage(current, { days })
    assert.equal(response.status, 400, `days=${days}`)
  }
})

test('usage: skills and agents all come, zeros included', async () => {
  const response = await usage(deps({ announced: () => LIST, usage: async () => ALL }))
  const names = (response.body as { counts: UsageCount[] }).counts.map((c) => c.name)
  assert.ok(['alpha', 'unused-skill', 'helper'].every((name) => names.includes(name)))
})

test('usage: only the commands the note names; clear never comes out even though the engine counted it', async () => {
  const response = await usage(deps({ announced: () => LIST, notes: { read: async () => NOTE }, usage: async () => ALL }))
  const names = (response.body as { counts: UsageCount[] }).counts.map((c) => c.name)
  assert.ok(names.includes('deploy'))
  assert.ok(!names.includes('clear'))
})

test('usage: with no note no command comes out', async () => {
  const response = await usage(deps({ announced: () => LIST, usage: async () => ALL }))
  const names = (response.body as { counts: UsageCount[] }).counts.map((c) => c.name)
  assert.deepEqual(names, ['alpha', 'unused-skill', 'helper'])
})

test('usage: a command the note names but the CLI does not announce does not come out', async () => {
  const note: NotesRead = { state: 'ok', parsed: { groups: [{ label: 'Ship', rows: [{ name: 'ghost', agent: false, why: undefined, when: undefined }] }], warnings: [] } }
  const response = await usage(deps({ announced: () => LIST, notes: { read: async () => note }, usage: async () => [...ALL, count('ghost', 9)] }))
  assert.ok(!(response.body as { counts: UsageCount[] }).counts.some((c) => c.name === 'ghost'))
})

test('usage: 200 no-store, with the list state the screen draws its header from', async () => {
  const response = await usage(deps({ announced: () => LIST, usage: async () => ALL }))
  assert.equal(response.status, 200)
  assert.deepEqual(response.headers, { 'cache-control': 'no-store' })
  assert.deepEqual((response.body as { list: unknown }).list, { state: 'known', since: LIST.since })
})
