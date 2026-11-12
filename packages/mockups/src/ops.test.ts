import assert from 'node:assert/strict'
import { test } from 'node:test'
import { abandonRun, acceptSubmit, archive, decide, findRun, linkSession, newMockup, stallRun, startRun } from './ops.ts'
import { mockup, NOW, OTHER_SESSION, SESSION, withStep } from './test-support.ts'
import type { Mockup, Result } from './types.ts'

const LATER = new Date(NOW.getTime() + 60_000)
const RUN = { kind: 'brief' as const, runId: 'r1', siteId: 'personal' }

function value(result: Result<Mockup>): Mockup {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.reason}`)
  return result.value
}
function code(result: Result<Mockup>): string {
  return result.ok ? 'ok' : result.error.code
}
/** A brief that ran once and is waiting at its gate. */
function waiting(): Mockup {
  const started = value(startRun(mockup({ id: 'm' }), RUN, NOW))
  return value(acceptSubmit(started, 'r1', { sessionId: SESSION, summary: 'done' }, LATER))
}

test('a new mockup: brief ready, the rest locked, open, nothing run', () => {
  const m = newMockup({ id: 'm', name: 'N', client: 'C', project: 'p', vaultDir: '/v', workDir: '/w', buildSiteId: null }, NOW)
  assert.equal(m.stages.brief.status, 'ready')
  for (const id of ['concepts', 'plan', 'build', 'deliver'] as const) assert.equal(m.stages[id].status, 'locked')
  assert.equal(m.status, 'open')
  assert.equal(m.createdAt, NOW.toISOString())
})

test('startRun: a ready stage gets its run and goes running', () => {
  const m = value(startRun(mockup({ id: 'm' }), RUN, NOW))
  assert.equal(m.stages.brief.status, 'running')
  assert.deepEqual(m.stages.brief.run, { id: 'r1', kind: 'brief', siteId: 'personal', startedAt: NOW.toISOString() })
})

test('crit. 19: a second start while a run is alive is a conflict', () => {
  const m = value(startRun(mockup({ id: 'm' }), RUN, NOW))
  assert.equal(code(startRun(m, { ...RUN, runId: 'r2' }, NOW)), 'conflict')
  const stalled = value(stallRun(m, 'r1', NOW))
  assert.equal(code(startRun(stalled, { ...RUN, runId: 'r2' }, NOW)), 'conflict')
})

test('startRun refuses a locked stage, a stage waiting without a redo, and an archived mockup', () => {
  assert.equal(code(startRun(mockup({ id: 'm' }), { ...RUN, kind: 'concepts' }, NOW)), 'conflict')
  assert.equal(code(startRun(waiting(), RUN, NOW)), 'conflict')
  assert.equal(code(startRun(mockup({ id: 'm', status: 'archived' }), RUN, NOW)), 'conflict')
})

test('a redo starts from waiting, carrying the comment and the version it replaces', () => {
  const m = value(startRun(waiting(), { ...RUN, runId: 'r2', redo: { comment: 'more on QR' } }, NOW))
  assert.deepEqual(m.stages.brief.run?.redo, { comment: 'more on QR', fromVersion: 1 })
  assert.equal(m.stages.brief.status, 'running')
})

test('a redo of a stage that never delivered is a conflict', () => {
  assert.equal(code(startRun(mockup({ id: 'm' }), { ...RUN, redo: { comment: 'x' } }, NOW)), 'conflict')
})

test('linkSession: once, idempotent with the same session, a conflict with another', () => {
  const m = value(linkSession(value(startRun(mockup({ id: 'm' }), RUN, NOW)), 'r1', SESSION, NOW))
  assert.equal(m.stages.brief.run?.sessionId, SESSION)
  assert.equal(code(linkSession(m, 'r1', SESSION, NOW)), 'ok')
  assert.equal(code(linkSession(m, 'r1', OTHER_SESSION, NOW)), 'conflict')
  assert.equal(code(linkSession(m, 'nope', SESSION, NOW)), 'not-found')
})

test('crit. 15: abandoning a first run puts the stage back to ready, without the run', () => {
  const m = value(abandonRun(value(startRun(mockup({ id: 'm' }), RUN, NOW)), 'r1', LATER))
  assert.equal(m.stages.brief.status, 'ready')
  assert.equal(m.stages.brief.run, undefined)
  assert.equal(m.updatedAt, LATER.toISOString())
})

test('crit. 15, 29: abandoning a redo puts the stage back to waiting, with the comment kept', () => {
  const redo = value(startRun(waiting(), { ...RUN, runId: 'r2', redo: { comment: 'more on QR' } }, NOW))
  const m = value(abandonRun(redo, 'r2', LATER))
  assert.equal(m.stages.brief.status, 'waiting')
  assert.equal(m.stages.brief.pendingComment, 'more on QR')
  assert.equal(m.stages.brief.version, 1)
})

test('abandoning a run that is not there is not-found', () => {
  assert.equal(code(abandonRun(mockup({ id: 'm' }), 'r1', NOW)), 'not-found')
})

test('crit. 17: stalling keeps the run; stalling twice is the same; a done stage cannot stall', () => {
  const m = value(stallRun(value(startRun(mockup({ id: 'm' }), RUN, NOW)), 'r1', NOW))
  assert.equal(m.stages.brief.status, 'stalled')
  assert.equal(m.stages.brief.run?.id, 'r1')
  assert.equal(code(stallRun(m, 'r1', NOW)), 'ok')
  assert.equal(code(stallRun(m, 'nope', NOW)), 'not-found')
})

test('acceptSubmit: a gated stage goes waiting, version 1, the run gone and the session linked', () => {
  const m = waiting()
  assert.equal(m.stages.brief.status, 'waiting')
  assert.equal(m.stages.brief.version, 1)
  assert.equal(m.stages.brief.run, undefined)
  assert.equal(m.stages.brief.summary, 'done')
})

test('crit. 17: a submission of a stalled run is accepted, and clears a pending comment', () => {
  const redo = value(startRun(waiting(), { ...RUN, runId: 'r2', redo: { comment: 'c' } }, NOW))
  const stalled = value(stallRun(redo, 'r2', NOW))
  const m = value(acceptSubmit(stalled, 'r2', { sessionId: SESSION, summary: 'again' }, LATER))
  assert.equal(m.stages.brief.status, 'waiting')
  assert.equal(m.stages.brief.version, 2)
  assert.equal(m.stages.brief.pendingComment, undefined)
})

test('acceptSubmit refuses a submission from another session than the linked one', () => {
  const linked = value(linkSession(value(startRun(mockup({ id: 'm' }), RUN, NOW)), 'r1', SESSION, NOW))
  assert.equal(code(acceptSubmit(linked, 'r1', { sessionId: OTHER_SESSION, summary: 's' }, NOW)), 'conflict')
})

test('acceptSubmit keeps the options a choosing stage delivered', () => {
  const options = [
    { id: 'a', title: 'A', blurb: 'a' },
    { id: 'b', title: 'B', blurb: 'b' },
  ]
  const m = withStep(mockup({ id: 'm' }), 'concepts', { status: 'running', run: { id: 'r', kind: 'concepts', siteId: 'p', startedAt: NOW.toISOString() } })
  const accepted = value(acceptSubmit(m, 'r', { sessionId: SESSION, summary: 's', options }, NOW))
  assert.deepEqual(accepted.stages.concepts.options, options)
})

test('crit. 27 / E4: approving the brief closes it and leaves concepts ready', () => {
  const m = value(decide(waiting(), { step: 'brief', action: 'approve' }, LATER))
  assert.equal(m.stages.brief.status, 'done')
  assert.equal(m.stages.concepts.status, 'ready')
  assert.deepEqual(m.stages.brief.history, [{ at: LATER.toISOString(), action: 'approve', version: 1 }])
})

test('decide refuses an action of another gate, a stage that is not waiting, and a redo without comment', () => {
  assert.equal(code(decide(waiting(), { step: 'brief', action: 'choose', optionId: 'a' }, NOW)), 'invalid')
  assert.equal(code(decide(mockup({ id: 'm' }), { step: 'brief', action: 'approve' }, NOW)), 'conflict')
  assert.equal(code(decide(waiting(), { step: 'brief', action: 'redo' }, NOW)), 'invalid')
})

test('crit. 28: choose needs an option the stage offered, and keeps it', () => {
  const options = [
    { id: 'a', title: 'A', blurb: 'a' },
    { id: 'b', title: 'B', blurb: 'b' },
  ]
  const m = withStep(mockup({ id: 'm' }), 'concepts', { status: 'waiting', version: 1, options })
  assert.equal(code(decide(m, { step: 'concepts', action: 'choose' }, NOW)), 'invalid')
  assert.equal(code(decide(m, { step: 'concepts', action: 'choose', optionId: 'z' }, NOW)), 'invalid')
  const chosen = value(decide(m, { step: 'concepts', action: 'choose', optionId: 'b' }, NOW))
  assert.equal(chosen.stages.concepts.chosen, 'b')
  assert.equal(chosen.stages.concepts.status, 'done')
  assert.equal(chosen.stages.plan.status, 'ready')
})

test('a redo decision records the comment and leaves the stage waiting for its run', () => {
  const m = value(decide(waiting(), { step: 'brief', action: 'redo', comment: 'more on QR' }, NOW))
  assert.equal(m.stages.brief.status, 'waiting')
  assert.deepEqual(m.stages.brief.history.at(-1), { at: NOW.toISOString(), action: 'redo', version: 1, comment: 'more on QR' })
})

test('archive: out of the gallery, unless a stage is running', () => {
  assert.equal(value(archive(mockup({ id: 'm' }), NOW)).status, 'archived')
  assert.equal(code(archive(value(startRun(mockup({ id: 'm' }), RUN, NOW)), NOW)), 'conflict')
})

test('findRun finds the stage of a run by its id', () => {
  const m = value(startRun(mockup({ id: 'm' }), RUN, NOW))
  assert.equal(findRun(m, 'r1')?.stage, 'brief')
  assert.equal(findRun(m, 'nope'), undefined)
})

test('ops never touch their input', () => {
  const before = mockup({ id: 'm' })
  const frozen = JSON.stringify(before)
  startRun(before, RUN, NOW)
  archive(before, NOW)
  assert.equal(JSON.stringify(before), frozen)
})

test('crit. 32: an accepted build keeps its preview URL on the mockup and waits at its gate', () => {
  const m = withStep(mockup({ id: 'm' }), 'build', { status: 'running', run: { id: 'b', kind: 'build', siteId: 'acme', startedAt: NOW.toISOString() } })
  const accepted = value(acceptSubmit(m, 'b', { sessionId: SESSION, summary: 's', previewUrl: 'https://acme-mockup-x.vercel.app' }, LATER))
  assert.equal(accepted.stages.build.status, 'waiting')
  assert.equal(accepted.urls.preview, 'https://acme-mockup-x.vercel.app')
  assert.equal(accepted.urls.prod, undefined)
})
