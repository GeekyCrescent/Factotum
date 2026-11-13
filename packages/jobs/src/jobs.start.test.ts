/**
 * C1 — `createJobs`'s start (design D13): the config, the startup write, the password file's health
 * without waiting and without reading it, relay mode, the time it takes, and `stop`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { insertApp, queueStore } from './ai/test-queue.ts'
import { NO_LETTER_YET, NO_REPRINT_YET, createJobs, failing } from './jobs.ts'
import { seedProfile } from './seed/test-seed.ts'
import { openDb } from './store/db.ts'
import * as repo from './store/repo.ts'
import { depsOf, NOW, rigIn, started } from './test-jobs.ts'
import { send, valueOf } from './test-state.ts'
import { eventually, tempBase } from './test-support.ts'
import { ok, type Opportunity } from './types.ts'

test('C1: a bad config switches jobs off with its reason; relay mode answers only where', async () => {
  using base = tempBase()
  const rig = rigIn(base.dir)

  const bad = await createJobs(depsOf(rig, { config: { ...rig.config, chromium: 'relative/chromium' } }))
  assert.equal(bad.ok, false)
  assert.match(bad.ok ? '' : bad.reason, /^jobs\.chromium: /)

  const relay = await createJobs(depsOf(rig, { config: { mode: 'relay', relayTo: 'omarchy' } }))
  assert.ok(relay.ok && 'relay' in relay)
  assert.deepEqual(relay.relay.where(), { mode: 'relay', host: 'omarchy' })
  await relay.relay.stop()
})

test('C1 start: the startup write runs in the opening tx (sending → send-unknown, running → requeued); a stored profile is kept', async () => {
  using base = tempBase()
  const rig = rigIn(base.dir)
  const db = await queueStore({ dir: rig.stateDir, [Symbol.dispose]: () => undefined })
  insertApp(db, { id: 'in-flight', state: 'sending', sends: [send()] })
  valueOf(
    db.tx((q) => {
      repo.insertProfileVersion(q, { version: 2, createdAt: NOW.toISOString(), profile: seedProfile() }, { kind: 'profile-saved' }, NOW)
      repo.insertWork(q, { id: 'w-running', kind: 'score', ref: 'in-flight', lane: 'bulk', state: 'running', attempts: 0, notBefore: null, reason: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
      return ok(undefined)
    }),
  )
  db.close()

  const jobs = await started(depsOf(rig))
  try {
    const app = valueOf(jobs.application('in-flight')).application
    assert.equal(app.state, 'send-unknown')
    assert.equal(app.sends[0]?.state, 'send-unknown')
    assert.equal(jobs.profile().version, 2)
  } finally {
    await jobs.stop()
  }
  const reopened = valueOf(await openDb({ dir: rig.stateDir, now: () => NOW }))
  assert.notEqual(reopened.read((q) => repo.getWork(q, 'w-running'))?.state, 'running')
  reopened.close()
})

test('C1 start: an empty store gets the seed profile as version 1', async () => {
  using base = tempBase()
  const jobs = await started(depsOf(rigIn(base.dir)))
  try {
    assert.equal(jobs.profile().version, 1)
    assert.ok(jobs.profile().profile.identity.phone !== '')
  } finally {
    await jobs.stop()
  }
})

test('C1 health: a 0644 password file reads «readable by others» once the lstat is back, without the path; jobs stays on', async () => {
  using base = tempBase()
  const rig = rigIn(base.dir, 0o644)
  const jobs = await started(depsOf(rig))
  try {
    await eventually(() => jobs.health().mail.state !== 'unknown', 'the lstat came back')
    const health = jobs.health()
    assert.equal(health.mail.state, 'bad')
    assert.match(health.mail.reason ?? '', /^Mail: password file is readable by others/)
    assert.ok(!(health.mail.reason ?? '').includes(rig.passwordFile))
    assert.ok(health.warnings.some((w) => w.startsWith('Mail: password file is readable by others')))
    assert.ok(jobs.overview().warnings.length > 0, 'the overview carries it')
    assert.equal(jobs.where().mode, 'host')
  } finally {
    await jobs.stop()
  }
})

test('C1 start: does not wait for the lstat (one that never answers), and never reads the password', async () => {
  using base = tempBase()
  let lstats = 0
  let reads = 0
  const deps = depsOf(rigIn(base.dir), {
    lstat: () => {
      lstats += 1
      return new Promise(() => undefined)
    },
    readPassword: async () => {
      reads += 1
      return { ok: true, password: 'x' }
    },
  })

  const jobs = await started(deps)
  try {
    assert.equal(lstats, 1)
    assert.equal(reads, 0, 'start never reads the content')
    assert.equal(jobs.health().mail.state, 'unknown')
  } finally {
    await jobs.stop()
  }
})

test('C1 health: a missing chromium or vault warns; the module still starts', async () => {
  using base = tempBase()
  const rig = rigIn(base.dir)
  const jobs = await started(depsOf(rig, { config: { ...rig.config, chromium: '/nonexistent/chromium', vault: { ...(rig.config.vault as object), root: '/nonexistent/vault' } } }))
  try {
    const health = jobs.health()
    assert.equal(health.paths.chromium, 'missing')
    assert.equal(health.paths.vault, 'missing')
    assert.equal(health.paths.pdfinfo, 'ok')
    assert.ok(health.warnings.some((w) => w.startsWith('Chromium:')))
  } finally {
    await jobs.stop()
  }
})

test('C1 start: fits in 10 s with a store of 100 companies and 80 applications', async () => {
  using base = tempBase()
  const rig = rigIn(base.dir)
  const db = await queueStore({ dir: rig.stateDir, [Symbol.dispose]: () => undefined })
  valueOf(
    db.tx((q) => {
      repo.insertProfileVersion(q, { version: 2, createdAt: NOW.toISOString(), profile: seedProfile() }, { kind: 'profile-saved' }, NOW)
      for (let i = 0; i < 100; i += 1) {
        repo.insertCompany(q, { id: `c${i}`, name: `Company ${i}`, nameKey: `company-${i}`, domain: null, website: null, careersUrl: null, linkedin: null, sector: null, size: null, location: null, isHealthEmployer: false, healthSource: null, ats: null, record: '' }, { kind: 'imported' }, NOW)
        const opportunity: Opportunity = { ...(repo.getOpportunity(q, 'opp-1') as Opportunity), id: `o${i}`, companyId: `c${i}`, url: null }
        repo.insertOpportunity(q, opportunity, `company-${i}|role`, { kind: 'imported' }, NOW)
      }
      return ok(undefined)
    }),
  )
  for (let i = 0; i < 80; i += 1) insertApp(db, { id: `a${i}`, companyId: `c${i}`, opportunityId: `o${i}`, state: 'draft' })
  db.close()

  const began = performance.now()
  const jobs = await started(depsOf(rig))
  const took = performance.now() - began
  try {
    assert.ok(took < 10_000, `start took ${Math.round(took)} ms`)
    assert.equal(jobs.overview().counts.draft, 80)
  } finally {
    await jobs.stop()
  }
})

test('C1 stop: twice is once; the letter handler fails with its reason until T1; «Retry print» waits for H5c', async () => {
  using base = tempBase()
  const jobs = await started(depsOf(rigIn(base.dir)))
  await Promise.all([jobs.stop(), jobs.stop()])

  const letter = await failing(NO_LETTER_YET)({} as never, { signal: new AbortController().signal, timeoutMs: 1 })
  assert.deepEqual(letter, { ok: false, kind: 'failed', reason: 'letter generation arrives with T1' })
  assert.equal(NO_REPRINT_YET, 'reprint arrives with H5c')
})
