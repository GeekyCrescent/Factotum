import { test } from 'node:test'
import assert from 'node:assert/strict'
import { skillsRoutes, type SkillsDeps } from './routes.ts'

const deps = (over: Partial<SkillsDeps> = {}): SkillsDeps => ({
  announced: () => ({ skills: ['alpha'], agents: [], commands: [], version: undefined, since: '2026-10-03T00:00:00.000Z' }),
  pinnedOf: (site) => (site === 'proj' ? ['alpha'] : []),
  notes: { read: async () => ({ state: 'off' }) },
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
