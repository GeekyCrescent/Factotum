import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionState, SessionSummary } from '../types.ts'
import { history, titleOf, UNTITLED, type Waiting } from './history.ts'

const session = (id: string, siteId: string, startedAt: string, prompt?: string, state: SessionState = 'finished'): SessionSummary => ({
  id,
  siteId,
  entryId: 'free',
  state,
  startedAt,
  endedAt: undefined,
  reason: undefined,
  turns: 1,
  prompt,
})
const labels = (groups: ReturnType<typeof history>) => groups.map((g) => [g.label, g.entries.map((e) => e.id)])

test('the title is the first line of the prompt that has words, cut', () => {
  assert.equal(titleOf('\n  Set up auth  \nwith details'), 'Set up auth')
  assert.equal(titleOf('x'.repeat(100)).length, 60)
  assert.equal(titleOf('x'.repeat(100)).endsWith('…'), true)
})

test('no prompt, or only blank lines, is Untitled', () => {
  assert.equal(titleOf(undefined), UNTITLED)
  assert.equal(titleOf(' \n '), UNTITLED)
})

test('ended sessions are grouped by project, newest project first, newest session first', () => {
  const groups = history(
    [
      session('a1', 'alpha', '2026-09-20T10:00:00Z'),
      session('b1', 'beta', '2026-09-28T10:00:00Z'),
      session('a2', 'alpha', '2026-09-29T09:00:00Z'),
    ],
    new Map(),
    '',
  )
  assert.deepEqual(labels(groups), [
    ['alpha', ['a2', 'a1']],
    ['beta', ['b1']],
  ])
})

test('what waits on the owner comes first, then what runs, and neither repeats in its project', () => {
  const waiting: Waiting = new Map([['w', { site: undefined, detail: 'Write notes.md' }]])
  const groups = history(
    [
      session('w', 'alpha', '2026-09-29T08:00:00Z', 'do it', 'running'),
      session('r', 'alpha', '2026-09-29T07:00:00Z', 'run', 'running'),
      session('f', 'alpha', '2026-09-29T06:00:00Z'),
    ],
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

test('a pending for a session not in the list still shows, under its site from the notice', () => {
  const waiting: Waiting = new Map([['gone', { site: 'beta', detail: 'Waiting for you' }]])
  const [needs] = history([], waiting, '')
  assert.equal(needs?.entries[0]?.site, 'beta')
  assert.equal(needs?.entries[0]?.title, 'beta')
})

test('search keeps what matches the title or the project, any case, and drops empty groups', () => {
  const sessions = [
    session('a', 'alpha', '2026-09-29T09:00:00Z', 'Set up AUTH'),
    session('b', 'beta', '2026-09-29T08:00:00Z', 'Home screen'),
    session('c', 'gamma-auth', '2026-09-29T07:00:00Z', 'Other'),
  ]
  assert.deepEqual(labels(history(sessions, new Map(), '  auth ')), [
    ['alpha', ['a']],
    ['gamma-auth', ['c']],
  ])
})

test('an empty search keeps everything', () => {
  assert.equal(history([session('a', 'alpha', '2026-09-29T09:00:00Z')], new Map(), '   ').length, 1)
})
