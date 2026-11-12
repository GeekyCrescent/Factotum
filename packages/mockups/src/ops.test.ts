import assert from 'node:assert/strict'
import { test } from 'node:test'
import { abandonRun, acceptSubmit, archive, decide, decideChange, findRun, linkSession, liveRun, newMockup, requestChange, stallRun, startRun } from './ops.ts'
import { mockup, NOW, OTHER_SESSION, SESSION, withStep } from './test-support.ts'
import { STAGE_IDS, type Change, type Mockup, type Result } from './types.ts'

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

test('crit. 33: an accepted deliver is done, keeps the production URL, and the mockup is delivered', () => {
  const m = withStep(mockup({ id: 'm', urls: { preview: 'https://acme-mockup-x.vercel.app' } }), 'deliver', { status: 'running', run: { id: 'd', kind: 'deliver', siteId: 'acme', startedAt: NOW.toISOString() } })
  const accepted = value(acceptSubmit(m, 'd', { sessionId: SESSION, summary: 's', prodUrl: 'https://acme-mockup.vercel.app' }, LATER))
  assert.equal(accepted.stages.deliver.status, 'done')
  assert.equal(accepted.stages.deliver.version, 1)
  assert.equal(accepted.status, 'delivered')
  assert.deepEqual(accepted.urls, { preview: 'https://acme-mockup-x.vercel.app', prod: 'https://acme-mockup.vercel.app' })
})

test('crit. 20: approving the build leaves deliver ready', () => {
  const m = withStep(withStep(mockup({ id: 'm' }), 'build', { status: 'waiting', version: 1 }), 'deliver', { status: 'locked' })
  const approved = value(decide(m, { step: 'build', action: 'approve' }, NOW))
  assert.equal(approved.stages.build.status, 'done')
  assert.equal(approved.stages.deliver.status, 'ready')
})

// ── The changes track (D2; criterion 36) ──

const PROD_URL = 'https://acme-mockup.vercel.app'

/** A delivered mockup: every stage done, both URLs. */
function delivered(): Mockup {
  let m = mockup({ id: 'm', buildSiteId: 'acme', status: 'delivered', urls: { preview: 'https://acme-mockup-b.vercel.app', prod: PROD_URL } })
  for (const id of STAGE_IDS) m = withStep(m, id, { status: 'done', version: 1 })
  return m
}
const CHANGE_RUN = { kind: 'change' as const, changeId: 'c1', runId: 'x1', siteId: 'acme' }
const asked = (): Mockup => value(requestChange(delivered(), { changeId: 'c1', text: 'Logo más grande' }, NOW))
const change = (m: Mockup): Change => m.changes.find((c) => c.id === 'c1') ?? assert.fail('no change c1')
/** A change that ran and handed its preview: waiting at its gate. */
function changeWaiting(): Mockup {
  const started = value(startRun(asked(), CHANGE_RUN, NOW))
  return value(acceptSubmit(started, 'x1', { sessionId: SESSION, summary: 's', previewUrl: 'https://acme-mockup-c-team.vercel.app' }, LATER))
}
const approved = (): Mockup => value(decideChange(changeWaiting(), { changeId: 'c1', action: 'approve' }, LATER))
const REDEPLOY = { kind: 'redeploy' as const, changeId: 'c1', runId: 'y1', siteId: 'acme' }

test('crit. 36: a change is asked of a delivered mockup: ready, phase change, and the mockup is changing', () => {
  const m = asked()
  assert.deepEqual(change(m), { id: 'c1', text: 'Logo más grande', phase: 'change', status: 'ready', version: 0, history: [] })
  assert.equal(m.status, 'changing')
})

test('crit. 36: no change before delivery, none on an archived mockup, and one open at a time', () => {
  assert.equal(code(requestChange(mockup({ id: 'm' }), { changeId: 'c1', text: 't' }, NOW)), 'conflict')
  assert.equal(code(requestChange({ ...delivered(), status: 'archived' }, { changeId: 'c1', text: 't' }, NOW)), 'conflict')
  assert.equal(code(requestChange(asked(), { changeId: 'c2', text: 'otro' }, NOW)), 'conflict')
})

test('crit. 36: a change runs on its own track — its run is found by id and is the live one', () => {
  const m = value(startRun(asked(), CHANGE_RUN, NOW))
  assert.equal(change(m).status, 'running')
  assert.equal(change(m).run?.kind, 'change')
  assert.equal(findRun(m, 'x1')?.change?.id, 'c1')
  assert.equal(findRun(m, 'x1')?.stage, undefined)
  assert.equal(liveRun(m)?.id, 'x1')
  assert.equal(code(startRun(m, { ...CHANGE_RUN, runId: 'x2' }, NOW)), 'conflict', 'crit. 19: one run at a time')
})

test('a change run needs its change: none, or another id, is not-found', () => {
  assert.equal(code(startRun(asked(), { ...CHANGE_RUN, changeId: 'nope' }, NOW)), 'not-found')
})

test('crit. 36: an accepted change waits at its own gate with its preview; the build’s preview stays', () => {
  const m = changeWaiting()
  assert.equal(change(m).status, 'waiting')
  assert.equal(change(m).version, 1)
  assert.equal(change(m).previewUrl, 'https://acme-mockup-c-team.vercel.app')
  assert.equal(m.urls.preview, 'https://acme-mockup-b.vercel.app')
  assert.equal(m.status, 'changing')
})

test('crit. 15, 29: abandoning a first change run goes back to ready; a redo’s, to waiting with its comment', () => {
  assert.equal(change(value(abandonRun(value(startRun(asked(), CHANGE_RUN, NOW)), 'x1', NOW))).status, 'ready')
  const redo = value(startRun(changeWaiting(), { ...CHANGE_RUN, runId: 'x2', redo: { comment: 'más grande aún' } }, NOW))
  const back = change(value(abandonRun(redo, 'x2', NOW)))
  assert.equal(back.status, 'waiting')
  assert.equal(back.pendingComment, 'más grande aún')
})

test('crit. 36: the change gate approves into phase approved, ready for its redeploy; a redo needs a comment', () => {
  const m = approved()
  assert.equal(change(m).phase, 'approved')
  assert.equal(change(m).status, 'ready')
  assert.deepEqual(change(m).history, [{ at: LATER.toISOString(), action: 'approve', version: 1 }])
  assert.equal(code(decideChange(changeWaiting(), { changeId: 'c1', action: 'redo' }, NOW)), 'invalid')
  assert.equal(code(decideChange(changeWaiting(), { changeId: 'c1', action: 'choose' }, NOW)), 'invalid')
  assert.equal(code(decideChange(asked(), { changeId: 'c1', action: 'approve' }, NOW)), 'conflict')
  assert.equal(code(decideChange(changeWaiting(), { changeId: 'nope', action: 'approve' }, NOW)), 'not-found')
  assert.equal(change(value(decideChange(changeWaiting(), { changeId: 'c1', action: 'redo', comment: 'x' }, NOW))).status, 'waiting')
})

test('crit. 36: a redeploy runs only on an approved change, and the change run is never launched again', () => {
  assert.equal(code(startRun(changeWaiting(), REDEPLOY, NOW)), 'conflict')
  assert.equal(code(startRun(approved(), { ...CHANGE_RUN, runId: 'x9' }, NOW)), 'conflict')
  const m = value(startRun(approved(), REDEPLOY, NOW))
  assert.equal(change(m).phase, 'redeploy')
  assert.equal(change(m).status, 'running')
})

test('crit. 36: a redeploy abandoned — stalled first or not — goes back to approved, with «Start redeploy»', () => {
  const running = value(startRun(approved(), REDEPLOY, NOW))
  for (const m of [running, value(stallRun(running, 'y1', NOW))]) {
    const back = change(value(abandonRun(m, 'y1', NOW)))
    assert.equal(back.phase, 'approved')
    assert.equal(back.status, 'ready')
    assert.equal(back.run, undefined)
  }
  assert.equal(change(value(stallRun(running, 'y1', NOW))).status, 'stalled')
})

test('crit. 36: an accepted redeploy closes the change, updates production, and the mockup is delivered again', () => {
  const m = value(acceptSubmit(value(startRun(approved(), REDEPLOY, NOW)), 'y1', { sessionId: SESSION, summary: 's', prodUrl: PROD_URL }, LATER))
  assert.equal(change(m).status, 'done')
  assert.equal(change(m).run, undefined)
  assert.equal(m.status, 'delivered')
  assert.equal(m.urls.prod, PROD_URL)
  assert.equal(code(requestChange(m, { changeId: 'c2', text: 'otro' }, NOW)), 'ok', 'the next change can be asked')
})

test('archive refuses a mockup whose change is running', () => {
  assert.equal(code(archive(value(startRun(asked(), CHANGE_RUN, NOW)), NOW)), 'conflict')
})
