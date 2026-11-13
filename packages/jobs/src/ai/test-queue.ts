/**
 * Test-only pieces of the queue's tests (G2a–G5): a store with one company, contact, opportunity and
 * profile; applications and follow-ups written straight in; handlers a test finishes by hand.
 */

import assert from 'node:assert/strict'
import { openDb, type Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { ADDRESSES, application, contact, followup, NOW, valueOf } from '../test-state.ts'
import { capturedLog, manualClock, type CapturedLog, type ManualClock, type TempBase } from '../test-support.ts'
import { ok, type Application, type Artifacts, type Followup, type Opportunity, type Profile } from '../types.ts'
import { createQueue, type JobHandler, type JobResult, type Queue, type QueueDeps } from './queue.ts'

const note = { kind: 'imported' } as const

const company: repo.NewCompany = {
  id: 'company-1',
  name: 'Acme',
  nameKey: 'acme',
  domain: 'acme.example',
  website: 'https://acme.example',
  careersUrl: null,
  linkedin: null,
  sector: null,
  size: null,
  location: null,
  isHealthEmployer: false,
  healthSource: null,
  ats: null,
  record: '',
}

const opportunity: Opportunity = {
  id: 'opp-1',
  companyId: 'company-1',
  kind: 'vacancy',
  title: 'Graduate engineer',
  goalId: null,
  url: null,
  postedAt: null,
  closesAt: null,
  startsAt: null,
  duration: null,
  hours: null,
  salary: null,
  requirements: '',
  score: null,
  breakdown: null,
  profileVersion: 1,
  source: 'seed',
  sourceRef: null,
  remote: null,
  status: 'open',
  discardReason: null,
  checkedAt: null,
}

export async function queueStore(base: TempBase): Promise<Db> {
  const opened = await openDb({ dir: base.dir, now: () => NOW })
  if (!opened.ok) assert.fail(opened.error.reason)
  const db = opened.value
  valueOf(
    db.tx((q) => {
      repo.insertCompany(q, company, note, NOW)
      repo.insertContact(q, contact(ADDRESSES.verifiedToday), note, NOW)
      repo.insertOpportunity(q, opportunity, 'acme|graduate', note, NOW)
      repo.insertProfileVersion(q, { version: 1, createdAt: NOW.toISOString(), profile: {} as Profile }, { kind: 'profile-saved' }, NOW)
      return ok(undefined)
    }),
  )
  return db
}

/** Version 1 of an application: the seed's letter, no CV yet. */
export const SEED_ARTIFACTS: Artifacts = {
  version: 1,
  cv: null,
  pdf: null,
  png: null,
  contactHash: null,
  letter: { subject: 'Hello', body: 'Seed letter {signature}' },
  form: [],
  skills: null,
  linkedin: null,
  profileVersion: 1,
  rules: [],
  usage: null,
  origin: 'seed',
}

/** Writes an application (default `draft`, version 1 with the seed's letter). */
export function insertApp(db: Db, overrides: Partial<Application> = {}, artifacts: Artifacts | null = SEED_ARTIFACTS): Application {
  const app = application({ state: 'draft', version: artifacts?.version ?? 0, ...overrides })
  valueOf(
    db.tx((q) => {
      repo.insertApplication(q, app, { seedKey: null }, note, NOW)
      if (artifacts !== null) repo.insertArtifacts(q, app.id, artifacts, NOW)
      return ok(undefined)
    }),
  )
  return app
}

export function insertFollowup(db: Db, overrides: Partial<Followup> = {}): Followup {
  const row = followup(overrides)
  valueOf(
    db.tx((q) => {
      repo.insertFollowup(q, row, { kind: 'followup-proposed' }, NOW)
      return ok(undefined)
    }),
  )
  return row
}

export const appOf = (db: Db, id: string): Application => {
  const app = db.read((q) => repo.getApplication(q, id))
  if (app === undefined) assert.fail(`no application ${id}`)
  return app
}

export const workOf = (db: Db, id: string): repo.Work => {
  const work = db.read((q) => repo.getWork(q, id))
  if (work === undefined) assert.fail(`no work ${id}`)
  return work
}

export const eventsOf = (db: Db, applicationId: string) => db.read((q) => repo.eventsOf(q, applicationId))

/** Done, with nothing to write. */
export const DONE: JobResult = { ok: true, output: { type: 'apply', apply: () => ok(undefined) } }

export interface Controlled {
  readonly handler: JobHandler
  /** The works the handler was called with, in order. */
  readonly calls: repo.Work[]
  /** Finishes the run of this work with `result`. */
  readonly finish: (workId: string, result?: JobResult) => void
  readonly started: () => readonly string[]
}

/** A handler whose runs end when the test says. */
export function controlled(): Controlled {
  const calls: repo.Work[] = []
  const pending = new Map<string, (result: JobResult) => void>()
  return {
    calls,
    handler: (work) => {
      calls.push(work)
      return new Promise<JobResult>((resolve) => pending.set(work.id, resolve))
    },
    finish: (workId, result = DONE) => {
      const resolve = pending.get(workId)
      if (resolve === undefined) assert.fail(`work ${workId} is not running`)
      pending.delete(workId)
      resolve(result)
    },
    started: () => calls.map((work) => work.id),
  }
}

export interface Rig {
  readonly queue: Queue
  readonly clock: ManualClock
  readonly log: CapturedLog
}

/** A queue over `db` with a clock the test moves; every handler and seam can be replaced. */
export function rig(db: Db, overrides: Partial<QueueDeps> = {}): Rig {
  const clock = manualClock(NOW)
  const log = capturedLog()
  const queue = createQueue({
    db,
    now: clock.now,
    concurrency: 2,
    handlers: {},
    log: log.log,
    lint: () => [],
    relintOne: () => ok(undefined),
    pdfExists: () => true,
    ...overrides,
  })
  return { queue, clock, log }
}
