import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '../types.ts'
import { servicesFromLog } from './history.ts'

const started = (seq: number, id: string, extra: Partial<Record<string, unknown>> = {}): SessionEvent =>
  ({ seq, at: `t${seq}`, kind: 'service', phase: 'started', id, command: `cmd ${id}`, cwd: '/w', maxMinutes: 480, pid: 100 + seq, ...extra }) as SessionEvent

const ended = (seq: number, id: string, extra: Partial<Record<string, unknown>> = {}): SessionEvent =>
  ({ seq, at: `t${seq}`, kind: 'service', phase: 'ended', id, outcome: 'stopped', ...extra }) as SessionEvent

test('a started without its ended is running, with everything the started said', () => {
  assert.deepEqual(servicesFromLog([started(3, 's1', { description: 'web', task: 'a1' })]), [
    {
      id: 's1',
      command: 'cmd s1',
      description: 'web',
      cwd: '/w',
      pid: 103,
      maxMinutes: 480,
      startedAt: 't3',
      task: 'a1',
      state: 'running',
      endedAt: undefined,
      by: undefined,
      code: undefined,
      signal: undefined,
      reason: undefined,
    },
  ])
})

test('an ended closes its started with the outcome and the details', () => {
  const [one, two, three] = servicesFromLog([
    started(1, 's1'),
    started(2, 's2'),
    started(3, 's3'),
    ended(4, 's2', { outcome: 'failed', code: 1 }),
    ended(5, 's1', { outcome: 'stopped', by: 'owner' }),
    ended(6, 's3', { outcome: 'shutdown', reason: 'factotum restarted' }),
  ])
  assert.deepEqual([one?.state, one?.by, one?.endedAt], ['stopped', 'owner', 't5'])
  assert.deepEqual([two?.state, two?.code], ['failed', 1])
  assert.deepEqual([three?.state, three?.reason], ['shutdown', 'factotum restarted'])
})

test('an ended with no started is ignored, and a second ended does not overwrite the first', () => {
  const views = servicesFromLog([ended(1, 's9'), started(2, 's1'), ended(3, 's1', { outcome: 'exited', code: 0 }), ended(4, 's1', { outcome: 'stopped' })])
  assert.equal(views.length, 1)
  assert.equal(views[0]?.state, 'exited')
})

test('the other kinds are ignored, and the order is the order they started in', () => {
  const log: SessionEvent[] = [
    { seq: 0, at: 't0', kind: 'message', role: 'user', text: 'go' },
    started(1, 's2'),
    { seq: 2, at: 't2', kind: 'state', state: 'finished', reason: undefined },
    started(3, 's1'),
  ]
  assert.deepEqual(
    servicesFromLog(log).map((view) => view.id),
    ['s2', 's1'],
  )
  // A `state` closes nothing: a service outlives its turn.
  assert.equal(servicesFromLog(log)[0]?.state, 'running')
})

test('two sessions are two logs: the same id in each is a different service', () => {
  const a = servicesFromLog([started(1, 's1', { command: 'a' })])
  const b = servicesFromLog([started(1, 's1', { command: 'b' }), ended(2, 's1')])
  assert.deepEqual([a[0]?.command, a[0]?.state], ['a', 'running'])
  assert.deepEqual([b[0]?.command, b[0]?.state], ['b', 'stopped'])
})
