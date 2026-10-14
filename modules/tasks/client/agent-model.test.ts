import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task } from '../types.ts'
import { agentPrompt, captureProjects, freePromptEntry, launchProblem, linkedState, projectState, type SetupView } from './agent-model.ts'

function card(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Fix the login bug',
    notes: '',
    status: 'todo',
    order: 'V',
    cycle: '2026-W42',
    area: null,
    project: { host: null, siteId: 'web' },
    priority: 0,
    labels: [],
    estimate: null,
    due: null,
    remindAt: null,
    remindedAt: null,
    reminderMissed: false,
    subtasks: [],
    source: { kind: 'owner' },
    sessions: [],
    createdAt: 'a',
    updatedAt: 'a',
    completedAt: null,
    ...over,
  }
}

const SETUP: SetupView = {
  sites: [
    { id: 'web', name: 'Web app', status: 'ok' },
    { id: 'gone', name: undefined, status: 'missing' },
  ],
  catalog: [
    { id: 'review', label: 'Code review', disabledReason: undefined, kind: 'command' },
    { id: 'off', label: 'Off', disabledReason: 'no such command', kind: undefined },
    { id: 'free', label: 'Free prompt', disabledReason: undefined, kind: 'none' },
  ],
}

test('crit. 30: the free-prompt entry, even when a command comes first', () => {
  assert.equal(freePromptEntry(SETUP.catalog), 'free')
})

test('crit. 30: none when the only free one is disabled, or when no entry says its kind (an earlier build)', () => {
  assert.equal(freePromptEntry([{ id: 'free', label: 'F', disabledReason: 'off', kind: 'none' }]), undefined)
  assert.equal(freePromptEntry([{ id: 'free', label: 'F', disabledReason: undefined }]), undefined)
  assert.equal(freePromptEntry([]), undefined)
})

test('the prompt: title, notes, and the open subtasks only', () => {
  const task = card({
    notes: 'Users on Safari cannot log in.',
    subtasks: [
      { id: 'a', text: 'Reproduce', done: true },
      { id: 'b', text: 'Write a test', done: false },
      { id: 'c', text: 'Fix it', done: false },
    ],
  })
  assert.equal(agentPrompt(task), 'Fix the login bug\n\nUsers on Safari cannot log in.\n\nOpen subtasks:\n- Write a test\n- Fix it')
  assert.equal(agentPrompt(card()), 'Fix the login bug')
})

test('the project on that host: ok, missing there, or not a project of that host', () => {
  assert.equal(projectState(SETUP, 'web'), 'ok')
  assert.equal(projectState(SETUP, 'gone'), 'missing')
  assert.equal(projectState(SETUP, 'other'), 'unknown')
})

const failure = (status: number, body?: unknown) => Object.assign(new Error('the message'), { status, body })

test('crit. 31 and 31b: busy, stale, unanswered on another host, or the rejection in words', () => {
  assert.deepEqual(launchProblem(failure(409, { conflict: { sessionId: 's1' } }), undefined), { kind: 'busy', sessionId: 's1' })
  assert.deepEqual(launchProblem(failure(409, { freshness: { clean: false, behind: 2, dirtyFiles: ['a.ts'] } }), undefined), {
    kind: 'stale',
    detail: '2 commits behind · uncommitted: a.ts',
  })
  assert.deepEqual(launchProblem(failure(502), 'mac'), { kind: 'unanswered' })
  // On the serving host a 502 is the daemon gone: an ordinary error.
  assert.deepEqual(launchProblem(failure(502), undefined), { kind: 'rejected', message: 'the message' })
  assert.deepEqual(launchProblem(failure(400), undefined), { kind: 'rejected', message: 'the message' })
})

test('crit. 32: a linked session reads as its state, deleted on a 404, unreachable otherwise', () => {
  assert.equal(linkedState({ ok: true, value: { state: 'running' } }), 'running')
  assert.equal(linkedState({ ok: true, value: { state: 'finished' } }), 'finished')
  assert.equal(linkedState({ ok: true, value: { state: 'weird' } }), 'unknown')
  assert.equal(linkedState({ ok: false, cause: failure(404) }), 'deleted')
  assert.equal(linkedState({ ok: false, cause: failure(502) }), 'unreachable')
  assert.equal(linkedState({ ok: false, cause: new Error('timeout') }), 'unreachable')
  assert.equal(linkedState('no-host'), 'unreachable')
})

test('S12: the capture’s projects, from every host that answered, with the host as the board stores it', () => {
  const where = { boardHost: undefined, selfName: 'omarchy' }
  const projects = captureProjects(
    [
      { host: undefined, setup: SETUP },
      { host: 'mac', setup: { sites: [{ id: 'notes', name: 'Notes', status: 'ok' }], catalog: [] } },
    ],
    where,
  )
  assert.deepEqual(projects, [
    { host: null, siteId: 'web', name: 'Web app' },
    { host: 'mac', siteId: 'notes', name: 'Notes' },
  ])
})

test('S12: at most 100, and a name always (the id when the project has none)', () => {
  const sites = Array.from({ length: 120 }, (_, i) => ({ id: `p${i}`, name: undefined, status: 'ok' as const }))
  const projects = captureProjects([{ host: undefined, setup: { sites, catalog: [] } }], { boardHost: undefined, selfName: 'omarchy' })
  assert.equal(projects.length, 100)
  assert.deepEqual(projects[0], { host: null, siteId: 'p0', name: 'p0' })
})
