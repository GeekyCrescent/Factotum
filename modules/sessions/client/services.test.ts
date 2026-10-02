import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '../types.ts'
import { activity } from './activity.ts'
import { fold, type Row, type ServiceRow } from './fold.ts'
import { hasLiveService, liveServices, serviceOutcome, viewOutcome } from './services.ts'

let seq = 0
const T0 = '2026-10-02T12:00:00.000Z'
const T1 = '2026-10-02T12:12:30.000Z'
const started = (id: string, extra: Record<string, unknown> = {}): SessionEvent =>
  ({ seq: seq++, at: T0, kind: 'service', phase: 'started', id, command: `cmd ${id}`, cwd: '/w', maxMinutes: 480, pid: 9, ...extra }) as SessionEvent
const ended = (id: string, extra: Record<string, unknown> = {}): SessionEvent =>
  ({ seq: seq++, at: T1, kind: 'service', phase: 'ended', id, outcome: 'stopped', ...extra }) as SessionEvent
const state = (s: 'running' | 'finished' | 'cancelled'): SessionEvent => ({ seq: seq++, at: T1, kind: 'state', state: s, reason: undefined })

const services = (rows: readonly Row[]) => rows.filter((row): row is ServiceRow => row.kind === 'service')

// --- fold (K1) -------------------------------------------------------------------

test('a started makes a row where it was launched, with seq, command, description and no end', () => {
  const log = [state('running'), started('s1', { description: 'web' })]
  const [row] = services(fold(log))
  assert.deepEqual(row, { kind: 'service', seq: log[1]?.seq, id: 's1', command: 'cmd s1', description: 'web', startedAt: T0, by: undefined, end: undefined })
})

test('a state does NOT close a service row: it outlives its turn; its ended does', () => {
  const log = [state('running'), started('s1'), state('finished'), state('running'), state('finished')]
  assert.equal(services(fold(log))[0]?.end, undefined)
  const closed = services(fold([...log, ended('s1', { outcome: 'failed', code: 1 })]))[0]
  assert.deepEqual(closed?.end, { outcome: 'failed', at: T1, code: 1, signal: undefined, reason: undefined })
})

test('a subagent that started it is named by its type, from the subagent rows', () => {
  const log: SessionEvent[] = [
    { seq: seq++, at: T0, kind: 'subagent', phase: 'started', task: 'a1', agent: 'general-purpose', description: 'x', background: false },
    started('s1', { task: 'a1' }),
    started('s2', { task: 'unknown-task' }),
  ]
  assert.deepEqual(
    services(fold(log)).map((row) => row.by),
    ['general-purpose', 'subagent'],
  )
})

test('an ended with no started, or a second ended, changes nothing', () => {
  const rows = services(fold([ended('s9'), started('s1'), ended('s1', { outcome: 'exited', code: 0 }), ended('s1', { outcome: 'stopped' })]))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.end?.outcome, 'exited')
})

// --- liveServices / hasLiveService (K2) -----------------------------------------------

test('liveServices reads the rows; hasLiveService reads the events; they agree (one rule, in fold)', () => {
  const logs: SessionEvent[][] = [
    [],
    [state('running'), started('s1')],
    [state('running'), started('s1'), state('finished')],
    [state('running'), started('s1'), started('s2'), ended('s1'), state('finished')],
    [state('running'), started('s1'), ended('s1')],
    [ended('s3')],
  ]
  for (const log of logs) {
    const live = liveServices(activity(fold(log)))
    assert.equal(hasLiveService(log), live.length > 0, JSON.stringify(log))
  }
  assert.deepEqual(
    liveServices(activity(fold(logs[3] as SessionEvent[]))).map((row) => row.id),
    ['s2'],
  )
})

// --- serviceOutcome: the seven cases (criterion 34) -------------------------------------------

test('serviceOutcome says each state in words, with its tone', () => {
  const row = (end: ServiceRow['end']): ServiceRow => ({ kind: 'service', seq: 1, id: 's1', command: 'x', description: undefined, startedAt: T0, by: undefined, end })
  const now = Date.parse(T1)
  const cases: [ServiceRow['end'], string, string][] = [
    [undefined, 'running · 12m 30s', 'running'],
    [{ outcome: 'exited', at: T1, code: 0 }, 'exited', 'finished'],
    [{ outcome: 'failed', at: T1, code: 1 }, 'failed: code 1', 'failed'],
    [{ outcome: 'failed', at: T1, signal: 'SIGSEGV' }, 'failed: SIGSEGV', 'failed'],
    [{ outcome: 'stopped', at: T1 }, 'stopped', 'cancelled'],
    [{ outcome: 'timeout', at: T1 }, 'timed out', 'cancelled'],
    [{ outcome: 'cancelled', at: T1 }, 'cancelled', 'cancelled'],
    [{ outcome: 'shutdown', at: T1, reason: 'factotum restarted' }, 'stopped by restart', 'cancelled'],
  ]
  for (const [end, text, tone] of cases) assert.deepEqual(serviceOutcome(row(end), now), { text, tone }, text)
})

test('viewOutcome says a ServiceView the same way serviceOutcome says its row', () => {
  const view = {
    id: 's1',
    command: 'x',
    description: undefined,
    cwd: '/w',
    pid: 9,
    maxMinutes: 480,
    startedAt: T0,
    task: undefined,
    state: 'failed' as const,
    endedAt: T1,
    by: undefined,
    code: 2,
    signal: undefined,
    reason: undefined,
  }
  assert.deepEqual(viewOutcome(view, Date.parse(T1)), { text: 'failed: code 2', tone: 'failed' })
  assert.deepEqual(viewOutcome({ ...view, state: 'running', endedAt: undefined, code: undefined }, Date.parse(T1)), { text: 'running · 12m 30s', tone: 'running' })
})
