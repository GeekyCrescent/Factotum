import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Color, ProjectView, SessionState, SessionSummary } from '../types.ts'
import { history, nameOf, titleOf, UNTITLED, type Group, type Waiting } from './history.ts'

const session = (
  id: string,
  siteId: string,
  startedAt: string,
  prompt?: string,
  state: SessionState = 'finished',
  title?: string,
  autoTitle?: string,
): SessionSummary => ({
  id,
  siteId,
  entryId: 'free',
  state,
  startedAt,
  endedAt: undefined,
  reason: undefined,
  turns: 1,
  prompt,
  title,
  autoTitle,
  archived: false,
})

const project = (id: string, sessions: SessionSummary[], extra: Partial<ProjectView> = {}): ProjectView => ({
  id,
  path: `/p/${id}`,
  name: undefined,
  color: undefined,
  status: 'ok',
  reason: undefined,
  isRepo: false,
  sessions,
  total: sessions.length,
  archived: 0,
  ...extra,
})

const labels = (groups: readonly Group[]) => groups.map((g) => [g.label, g.entries.map((e) => e.id)])

test('the title is the first line of the prompt that has words, cut', () => {
  assert.equal(titleOf('\n  Set up auth  \nwith details'), 'Set up auth')
  assert.equal(titleOf('x'.repeat(100)).length, 60)
  assert.equal(titleOf('x'.repeat(100)).endsWith('…'), true)
})

test('no prompt, or only blank lines, is Untitled', () => {
  assert.equal(titleOf(undefined), UNTITLED)
  assert.equal(titleOf(' \n '), UNTITLED)
})

test('THE OWNER’S TITLE WINS over the prompt; without one, the prompt (D5)', () => {
  assert.equal(nameOf({ title: 'Tax return', prompt: 'do my taxes' }), 'Tax return')
  assert.equal(nameOf({ title: undefined, prompt: 'do my taxes' }), 'do my taxes')
})

test('one group per project, in the registry’s order, newest conversation first, named by the project’s name', () => {
  const groups = history(
    [
      project('alpha', [session('a2', 'alpha', '2026-09-29T09:00:00Z'), session('a1', 'alpha', '2026-09-20T10:00:00Z')], { name: 'Alpha app', color: 3 as Color }),
      project('beta', [session('b1', 'beta', '2026-09-28T10:00:00Z', 'x', 'finished', 'Renamed')]),
    ],
    new Map(),
    new Map(),
    '',
  )
  assert.deepEqual(labels(groups), [
    ['Alpha app', ['a2', 'a1']],
    ['beta', ['b1']],
  ])
  assert.equal(groups[0]?.project?.color, 3)
  assert.equal(groups[0]?.entries[0]?.siteLabel, 'Alpha app')
  assert.equal(groups[1]?.entries[0]?.title, 'Renamed')
})

test('what waits on the owner comes first, then what runs, and neither repeats in its project', () => {
  const waiting: Waiting = new Map([['w', { site: undefined, detail: 'Write notes.md' }]])
  const groups = history(
    [
      project('alpha', [
        session('w', 'alpha', '2026-09-29T08:00:00Z', 'do it', 'running'),
        session('r', 'alpha', '2026-09-29T07:00:00Z', 'run', 'running'),
        session('f', 'alpha', '2026-09-29T06:00:00Z'),
      ]),
    ],
    new Map(),
    waiting,
    '',
  )
  assert.deepEqual(labels(groups), [
    ['Needs you', ['w']],
    ['Running', ['r']],
    ['alpha', ['f']],
  ])
  assert.equal(groups[0]?.entries[0]?.detail, 'Write notes.md')
  assert.equal(groups[0]?.entries[0]?.title, 'do it')
})

test('a pending for a session not loaded still shows, under the site the notice carried', () => {
  const waiting: Waiting = new Map([['gone', { site: 'beta', detail: 'Waiting for you' }]])
  const [needs] = history([], new Map(), waiting, '')
  assert.equal(needs?.entries[0]?.site, 'beta')
  assert.equal(needs?.entries[0]?.title, 'beta')
})

test('SHOW MORE: offered while the total is above what is loaded, and what was loaded joins the group (criterion 35)', () => {
  const eight = Array.from({ length: 8 }, (_, i) => session(`s${i}`, 'alpha', `2026-09-2${i}T00:00:00Z`))
  const first = history([project('alpha', eight, { total: 10 })], new Map(), new Map(), '')
  assert.equal(first[0]?.project?.hasMore, true)
  const rest = [session('old1', 'alpha', '2026-09-01T00:00:00Z'), session('old2', 'alpha', '2026-09-02T00:00:00Z')]
  const after = history([project('alpha', eight, { total: 10 })], new Map([['alpha', [...eight, ...rest]]]), new Map(), '')
  assert.equal(after[0]?.entries.length, 10)
  assert.equal(after[0]?.project?.hasMore, false)
  assert.equal(after[0]?.entries.at(-1)?.id, 'old1')
})

test('A MISSING PROJECT and an empty one still show their group, with no conversations (criteria 23, 25)', () => {
  const groups = history(
    [project('gone', [], { status: 'missing', reason: 'does not exist', total: 4 }), project('empty', [])],
    new Map(),
    new Map(),
    '',
  )
  assert.deepEqual(labels(groups), [
    ['gone', []],
    ['empty', []],
  ])
  assert.equal(groups[0]?.project?.status, 'missing')
  assert.equal(groups[0]?.project?.hasMore, false, 'a missing project offers nothing to show')
})

test('search keeps what matches the title, the project id or its name, any case, and drops empty groups', () => {
  const groups = history(
    [
      project('alpha', [session('a', 'alpha', '2026-09-29T09:00:00Z', 'Set up AUTH')]),
      project('beta', [session('b', 'beta', '2026-09-29T08:00:00Z', 'Home screen')], { name: 'Garden' }),
      project('gamma-auth', [session('c', 'gamma-auth', '2026-09-29T07:00:00Z', 'Other')]),
    ],
    new Map(),
    new Map(),
    'auth',
  )
  assert.deepEqual(labels(groups), [
    ['alpha', ['a']],
    ['gamma-auth', ['c']],
  ])
  const byName = history([project('beta', [session('b', 'beta', '2026-09-29T08:00:00Z', 'x')], { name: 'Garden' })], new Map(), new Map(), 'GARD')
  assert.deepEqual(labels(byName), [['Garden', ['b']]])
})
