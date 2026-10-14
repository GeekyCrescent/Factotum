import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  actionsFor,
  bytesText,
  failureText,
  isSettled,
  outcomeOf,
  pathsOf,
  plannedLine,
  reasonText,
  warningText,
  type PlannedView,
  type ReportProject,
  type ReportView,
  type SheetState,
} from './handoff.ts'

const planned: PlannedView = {
  siteId: 'vault',
  targetSiteId: 'obsidian',
  branch: 'main',
  sessions: ['a', 'b'],
  localCommits: 1,
  changedFiles: 3,
  newUntracked: ['notes/new.md'],
  bytes: 1_500_000,
  warnings: [],
}

const project = (over: Partial<ReportProject>): ReportProject => ({
  siteId: 'vault',
  phase: 'done',
  sessions: ['a'],
  warnings: [],
  stoppedServices: [],
  targetWarnings: [],
  ...over,
})

test('what a project that goes says: its sessions, the commits that travel and that nothing is pushed, the changes and the size', () => {
  assert.equal(plannedLine(planned), '2 sessions · 1 local commit goes with it (nothing is pushed) · 3 changed files · 1.5 MB')
  assert.equal(plannedLine({ ...planned, sessions: ['a'], localCommits: 0, changedFiles: 0, bytes: 900 }), '1 session · 900 B')
})

test('sizes read like sizes', () => {
  assert.equal(bytesText(0), '0 B')
  assert.equal(bytesText(2048), '2 KB')
  assert.equal(bytesText(268_435_456), '268.4 MB')
})

test('every reason of design D7 and D8 is said in plain words, with the host and the branch where it needs them', () => {
  assert.equal(reasonText('target-ahead', 'omarchy', 'main'), "omarchy has commits on main that this host doesn't. Pull them here first.")
  assert.equal(reasonText('target-ignored-collision', 'omarchy'), 'omarchy ignores these files and has its own copy. Move them or align the ignore rules (docs/hosts.md).')
  assert.equal(reasonText('abort-failed', 'omarchy'), 'omarchy could not undo everything: run factotum doctor there.')
  for (const reason of [
    'running', 'project-busy', 'project-not-portable', 'ambiguous-remote', 'no-clone-on-target', 'detached-head', 'target-dirty', 'target-busy',
    'entry-missing-on-target', 'cli-transcript-missing', 'too-large', 'too-slow-to-send', 'history-diverged', 'code-too-large',
    'bundle-base-missing', 'head-mismatch', 'wip-apply-failed', 'expired', 'not-found', 'source-changed-during-handoff', 'too-many-files',
    'source-error', 'restarted', 'install-failed',
  ]) {
    const text = reasonText(reason, 'omarchy')
    assert.notEqual(text, reason, `${reason} has words`)
    assert.equal(text.includes('—'), false, 'no em dash on screen (criterion 41)')
  }
  assert.equal(reasonText('something-new', 'omarchy'), 'something-new')
})

test('the warnings: ignore-rules-differ, target-rescued with its ref, upload-collision, source-changed-during-handoff', () => {
  assert.equal(warningText('ignore-rules-differ', 'omarchy', 'h1'), 'The two hosts ignore different files outside this repo. See docs/hosts.md.')
  assert.match(warningText('target-rescued', 'omarchy', 'h1'), /refs\/factotum\/handoff-rescue\/h1/)
  assert.match(warningText('upload-collision', 'omarchy', 'h1'), /kept its own/)
  assert.match(warningText('source-changed-during-handoff', 'omarchy', 'h1'), /refs\/factotum\/handoff-backup\/h1/)
})

test('a failed preview says why, and how to go on', () => {
  assert.match(failureText('peer-unreachable', 'omarchy'), /omarchy did not answer/)
  assert.match(failureText('peer-timeout', 'omarchy'), /took too long/)
  assert.equal(failureText('peer-error', 'omarchy').includes('—'), false)
})

test('the outcome of a project in the report, by its phase and by what the target said', () => {
  assert.deepEqual(outcomeOf(project({ phase: 'done' }), 'omarchy', 'h'), { tone: 'moved', text: '1 session moved to omarchy', notes: [] })
  assert.equal(outcomeOf(project({ phase: 'aborted', targetReason: 'target-dirty' }), 'omarchy', 'h').tone, 'stayed')
  assert.match(outcomeOf(project({ phase: 'aborted', targetReason: 'target-dirty' }), 'omarchy', 'h').text, /uncommitted changes on omarchy/)
  assert.match(outcomeOf(project({ phase: 'aborted', reason: 'project-busy' }), 'omarchy', 'h').text, /working/)
  assert.equal(outcomeOf(project({ phase: 'pending-peer' }), 'omarchy', 'h').tone, 'waiting')
  assert.equal(outcomeOf(project({ phase: 'kept' }), 'omarchy', 'h').tone, 'kept')
  assert.equal(outcomeOf(project({ phase: 'sending' }), 'omarchy', 'h').tone, 'moving')
  const notes = outcomeOf(project({ phase: 'done', warnings: ['source-changed-during-handoff'], targetWarnings: ['upload-collision'], stoppedServices: ['s1', 's2'] }), 'omarchy', 'h').notes
  assert.equal(notes.length, 3)
  assert.match(notes[0] ?? '', /Stopped 2 background services/)
})

test('the paths of a collision: the ones that came, and "and N more" past them', () => {
  assert.deepEqual(pathsOf(project({ targetPaths: ['a', 'b'], targetPathCount: 5 })), { shown: ['a', 'b'], more: 3 })
  assert.deepEqual(pathsOf(project({})), { shown: [], more: 0 })
})

const report = (over: Partial<ReportView>): ReportView => ({ hid: 'h', peer: 'omarchy', startedAt: 'x', state: 'finished', projects: [], ...over })

test('a report is settled once the run is over and no project is still on its way; a pending-peer is settled (it waits on the owner)', () => {
  assert.equal(isSettled(report({ state: 'running' })), false)
  assert.equal(isSettled(report({ state: 'finished', projects: [project({ phase: 'sending' })] })), false)
  assert.equal(isSettled(report({ state: 'finished', projects: [project({ phase: 'pending-peer' })] })), true)
  assert.equal(isSettled(report({ state: 'failed', failure: 'peer-unreachable' })), true)
})

test('WHICH BUTTONS, by step (K1): Cancel while it looks; Confirm only with something to move; Try again when it failed; nothing while it moves; Close at the end, and Keep them here on a pending-peer', () => {
  const states: [SheetState, readonly string[]][] = [
    [{ step: 'preview', preview: { state: 'running' } }, ['cancel']],
    [{ step: 'preview', preview: { state: 'ready', plan: { projects: [planned], skipped: [], totals: { archived: 0, tooOld: 0 } } } }, ['cancel', 'confirm']],
    [{ step: 'preview', preview: { state: 'ready', plan: { projects: [], skipped: [], totals: { archived: 0, tooOld: 0 } } } }, ['cancel']],
    [{ step: 'preview', preview: { state: 'failed', reason: 'peer-unreachable' } }, ['cancel', 'retry']],
    [{ step: 'moving', report: undefined }, []],
    [{ step: 'moving', report: report({ state: 'running' }) }, []],
    [{ step: 'moving', report: report({ projects: [project({ phase: 'done' })] }) }, ['close']],
    [{ step: 'moving', report: report({ projects: [project({ phase: 'pending-peer' })] }) }, ['close', 'keep:vault']],
  ]
  for (const [state, expected] of states) assert.deepEqual(actionsFor(state), expected, JSON.stringify(state))
})
