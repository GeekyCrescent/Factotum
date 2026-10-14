import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionMeta } from '../store.ts'
import { plan, type PlanFacts, type PlanProject, type PlanSession, type TargetProject } from './plan.ts'

const NOW = new Date('2026-10-14T12:00:00.000Z')
const HOUR = 3_600_000
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString()
const HEAD = 'a'.repeat(40)
const DIGEST = { global: 'none', info: 'none' }

let n = 0
const sid = () => `0199e0c0-0000-7000-8000-${String((n += 1)).padStart(12, '0')}`

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: sid(),
    siteId: 'vault',
    entryId: 'free',
    state: 'finished',
    startedAt: ago(2),
    endedAt: ago(1),
    reason: undefined,
    turns: 1,
    agentPid: undefined,
    sitePath: '/Users/ferro/vault',
    prompt: 'p',
    agent: undefined,
    title: undefined,
    autoTitle: undefined,
    archivedAt: undefined,
    touchedAt: ago(1),
    movedTo: undefined,
    movedAt: undefined,
    ...over,
  }
}

function session(over: Partial<SessionMeta> = {}, extra: Partial<PlanSession> = {}): PlanSession {
  return { meta: meta(over), fileBytes: [100, 200], transcriptFound: true, ...extra }
}

function project(over: Partial<PlanProject> = {}): PlanProject {
  return {
    siteId: 'vault',
    key: 'github.com/geekycrescent/jarvis-vault',
    branch: 'main',
    head: HEAD,
    busy: false,
    localCommits: 1,
    changedFiles: 2,
    newUntracked: ['notes/new.md'],
    ignoreDigest: DIGEST,
    sessions: [session()],
    ...over,
  }
}

function target(over: Partial<TargetProject> = {}): TargetProject {
  return {
    key: 'github.com/geekycrescent/jarvis-vault',
    siteId: 'obsidian',
    clean: true,
    busy: false,
    branch: 'main',
    head: HEAD,
    heads: { main: HEAD },
    entries: ['free'],
    ignoreDigest: DIGEST,
    ...over,
  }
}

const noFacts: PlanFacts = { targetTipIsAncestor: new Map([['vault', true]]), diverged: new Set() }

test('a project that can go: its sessions, the commits and the untracked files that travel, its size, and the target’s siteId', () => {
  const p = project({ sessions: [session(), session()] })
  const result = plan([p], [target()], noFacts, NOW)
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(result.projects, [
    {
      siteId: 'vault',
      targetSiteId: 'obsidian',
      branch: 'main',
      head: HEAD,
      sessions: p.sessions.map((s) => s.meta.id),
      localCommits: 1,
      changedFiles: 2,
      newUntracked: ['notes/new.md'],
      bytes: 600,
      warnings: [],
    },
  ])
})

test('archived and too-old come out as TOTALS, and do not hold their project back', () => {
  const p = project({ sessions: [session({ archivedAt: ago(1) }), session({ touchedAt: ago(30) }), session()] })
  const result = plan([p], [target()], noFacts, NOW)
  assert.deepEqual(result.totals, { archived: 1, tooOld: 1 })
  assert.equal(result.projects[0]?.sessions.length, 1)
})

test('too-old reads touchedOf: launched three days ago and answered an hour ago goes; with no touchedAt it falls to endedAt, then startedAt', () => {
  const answered = session({ startedAt: ago(72), touchedAt: ago(1) })
  const oldEnded = session({ startedAt: ago(72), touchedAt: undefined, endedAt: ago(48) })
  const freshStart = session({ startedAt: ago(2), touchedAt: undefined, endedAt: undefined })
  const result = plan([project({ sessions: [answered, oldEnded, freshStart] })], [target()], noFacts, NOW)
  assert.deepEqual(result.projects[0]?.sessions, [answered.meta.id, freshStart.meta.id])
  assert.equal(result.totals.tooOld, 1)
})

test('a session already moved is not listed at all: it is not this host’s', () => {
  const result = plan([project({ sessions: [session({ movedTo: 'omarchy' }), session()] })], [target()], noFacts, NOW)
  assert.equal(result.projects[0]?.sessions.length, 1)
  assert.deepEqual(result.skipped, [])
})

test('a running session is `running`, and the others of its project are `project-busy` (criterion 24)', () => {
  const running = session({ state: 'running' })
  const idle = session()
  const result = plan([project({ busy: true, sessions: [running, idle] })], [target()], noFacts, NOW)
  assert.deepEqual(result.projects, [])
  assert.deepEqual(result.skipped, [
    { siteId: 'vault', sessionId: running.meta.id, reason: 'running' },
    { siteId: 'vault', sessionId: idle.meta.id, reason: 'project-busy' },
  ])
})

const projectReasons: [string, (ps: PlanProject[], ts: TargetProject[]) => [PlanProject[], TargetProject[]], PlanFacts?][] = [
  ['project-not-portable', (ps, ts) => [ps.map((p) => ({ ...p, key: undefined })), ts]],
  ['ambiguous-remote', (ps, ts) => [ps, [...ts, target({ siteId: 'copy' })]]],
  ['no-clone-on-target', (ps) => [ps, [target({ key: 'github.com/someone/else' })]]],
  ['detached-head', (ps, ts) => [ps.map((p) => ({ ...p, branch: undefined })), ts]],
  ['target-dirty', (ps) => [ps, [target({ clean: false })]]],
  ['target-busy', (ps) => [ps, [target({ busy: true })]]],
  ['target-ahead', (ps, ts) => [ps, ts], { targetTipIsAncestor: new Map([['vault', false]]), diverged: new Set() }],
]

for (const [reason, change, facts] of projectReasons) {
  test(`a project that cannot go for one reason of its own: ${reason}, once, with its siteId`, () => {
    const [ps, ts] = change([project({ sessions: [session(), session()] })], [target()])
    const result = plan(ps, ts, facts ?? noFacts, NOW)
    assert.deepEqual(result.projects, [])
    assert.deepEqual(result.skipped, [{ siteId: 'vault', reason }])
  })
}

test('ambiguous-remote also when the SOURCE has the remote twice', () => {
  const result = plan([project(), project({ siteId: 'vault-copy' })], [target()], { ...noFacts, targetTipIsAncestor: new Map([['vault', true], ['vault-copy', true]]) }, NOW)
  assert.deepEqual(result.skipped.map((s) => s.reason), ['ambiguous-remote', 'ambiguous-remote'])
})

test('target-ahead needs no fact when the target does not have the branch: a branch it lacks is never ahead', () => {
  const result = plan([project({ branch: 'feature' })], [target({ heads: { main: HEAD } })], { targetTipIsAncestor: new Map(), diverged: new Set() }, NOW)
  assert.equal(result.projects.length, 1)
})

test('target-ahead when the target has the branch and no fact says its tip is an ancestor (the source lacks the object)', () => {
  const result = plan([project()], [target()], { targetTipIsAncestor: new Map(), diverged: new Set() }, NOW)
  assert.deepEqual(result.skipped, [{ siteId: 'vault', reason: 'target-ahead' }])
})

const retaining: [string, (s: PlanSession) => PlanSession][] = [
  ['entry-missing-on-target', (s) => ({ ...s, meta: { ...s.meta, entryId: 'only-on-the-mac' } })],
  ['cli-transcript-missing', (s) => ({ ...s, transcriptFound: false })],
  ['too-large', (s) => ({ ...s, fileBytes: [256 * 1024 * 1024 + 1] })],
]

for (const [reason, spoil] of retaining) {
  test(`ONE CANDIDATE THAT CANNOT GO HOLDS ITS PROJECT BACK (v4.2): ${reason}, with siteId and sessionId, and neither session goes`, () => {
    const good = session()
    const bad = spoil(session())
    const result = plan([project({ sessions: [good, bad] })], [target()], noFacts, NOW)
    assert.deepEqual(result.projects, [])
    assert.deepEqual(result.skipped, [{ siteId: 'vault', sessionId: bad.meta.id, reason }])
  })
}

test('too-slow-to-send holds the project too: a file that would not get there in HANDOFF_FILE_MAX_SECONDS at the assumed speed', () => {
  const slow = session({}, { fileBytes: [10_000_000] })
  const result = plan([project({ sessions: [session(), slow] })], [target()], noFacts, NOW, { mbps: 0.01, maxSeconds: 240, maxBytes: 256 * 1024 * 1024 })
  assert.deepEqual(result.skipped, [{ siteId: 'vault', sessionId: slow.meta.id, reason: 'too-slow-to-send' }])
})

test('history-diverged is by project: one session the target has that went another way holds the whole project', () => {
  const diverged = session()
  const result = plan([project({ sessions: [session(), diverged] })], [target()], { ...noFacts, diverged: new Set([diverged.meta.id]) }, NOW)
  assert.deepEqual(result.projects, [])
  assert.deepEqual(result.skipped, [{ siteId: 'vault', sessionId: diverged.meta.id, reason: 'history-diverged' }])
})

test('different ignore rules are a WARNING, never a reason: the project still goes (criterion 23)', () => {
  const result = plan([project()], [target({ ignoreDigest: { global: 'abc', info: 'none' } })], noFacts, NOW)
  assert.deepEqual(result.projects[0]?.warnings, ['ignore-rules-differ'])
})

test('a project with no candidates is not in the plan at all', () => {
  const result = plan([project({ sessions: [session({ touchedAt: ago(48) })] })], [target()], noFacts, NOW)
  assert.deepEqual(result.projects, [])
  assert.deepEqual(result.skipped, [])
  assert.equal(result.totals.tooOld, 1)
})
