import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createQueue } from './ai/queue.ts'
import { queueStore } from './ai/test-queue.ts'
import { BACKUP_FAILING, BACKUP_FAILURES_FLAG, BACKUP_KEEP, CLOCK_MS, createClock, type ClockDeps } from './clock.ts'
import type { Db } from './store/db.ts'
import * as repo from './store/repo.ts'
import { application, NOW, valueOf } from './test-state.ts'
import { capturedLog, manualClock, manualTimers, tempBase } from './test-support.ts'
import { ok } from './types.ts'

const HOUR = 3_600_000

function clockRig(db: Db, dir: string, overrides: Partial<ClockDeps> = {}) {
  const timers = manualTimers()
  const time = manualClock(NOW)
  const log = capturedLog()
  const calls: string[] = []
  const queue = createQueue({ db, now: time.now, concurrency: 2, handlers: {}, log: log.log, lint: () => [], relintOne: () => ok(undefined), pdfExists: () => true })
  const clock = createClock({
    db,
    timers: timers.timers,
    now: time.now,
    timeZone: 'Australia/Sydney',
    log: log.log,
    stateDir: dir,
    pump: () => void calls.push('pump'),
    prepareTick: () => {
      calls.push('checks')
      return 0
    },
    enqueueCv: queue.enqueueCv,
    seedFiles: () => ['wave2.md'],
    ...overrides,
  })
  return { clock, timers, time, log, calls }
}

function heldDraft(db: Db, id: string, holdUntil: string, seedKey = `wave2.md#${id}`): void {
  valueOf(db.tx((q) => ok(repo.insertApplication(q, application({ id, state: 'draft', version: 0, holdUntil }), { seedKey }, { kind: 'imported' }, NOW))))
}

const stateOf = (db: Db, id: string): string | undefined => db.read((q) => repo.getApplication(q, id)?.state)

test('the first round runs at once, then every 60 s on the injected timers: the pump and the checks each round', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { clock, timers, calls } = clockRig(db, base.dir)
  clock.start()
  await clock.idle()
  assert.deepEqual(calls, ['pump', 'checks'])
  assert.equal(timers.tick(CLOCK_MS), 1)
  await clock.idle()
  assert.deepEqual(calls, ['pump', 'checks', 'pump', 'checks'])
  await clock.stop()
  assert.equal(timers.tick(CLOCK_MS), 0, 'the interval is gone')
})

test('one round at a time: a tick that comes while a round runs is skipped', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  let reentered = 0
  const holder: { tick?: () => number } = {}
  const { clock, timers, calls } = clockRig(db, base.dir, {
    pump: () => {
      calls.push('pump')
      reentered += holder.tick?.() ?? 0
    },
  })
  holder.tick = () => timers.tick(CLOCK_MS)
  clock.start()
  await clock.idle()
  assert.equal(reentered, 1, 'the timer fired inside the round')
  assert.deepEqual(calls, ['pump', 'checks'], 'and its round never ran')
  await clock.stop()
})

test('a task that throws is logged and the others still run; the round never throws', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { clock, calls, log } = clockRig(db, base.dir, {
    pump: () => {
      throw new Error('boom')
    },
  })
  clock.start()
  await clock.idle()
  assert.deepEqual(calls, ['checks'])
  assert.ok(log.lines.some((line) => line.startsWith('error') && line.includes('pump') && line.includes('boom')))
  await clock.stop()
})

test('R8: the daily copy is VACUUM INTO backups/jobs-<day>.db, 0600 under umask 022, in a 0700 folder; once a day', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const previous = process.umask(0o022)
  try {
    const { clock, timers, time } = clockRig(db, base.dir)
    clock.start()
    await clock.idle()
    const dir = join(base.dir, 'backups')
    // 11:00 in Sydney on the 14th.
    assert.deepEqual(readdirSync(dir), ['jobs-2026-11-14.db'])
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, 'jobs-2026-11-14.db')).mode & 0o777, 0o600)
    time.advance(HOUR)
    timers.tick(CLOCK_MS)
    await clock.idle()
    assert.deepEqual(readdirSync(dir), ['jobs-2026-11-14.db'], 'not twice the same day')
    time.advance(24 * HOUR)
    timers.tick(CLOCK_MS)
    await clock.idle()
    assert.deepEqual(readdirSync(dir).sort(), ['jobs-2026-11-14.db', 'jobs-2026-11-15.db'])
    await clock.stop()
  } finally {
    process.umask(previous)
  }
})

test('R8: seven copies are kept, the oldest go, and every copy left in backups/ is 0600', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const dir = join(base.dir, 'backups')
  valueOf(db.backup(join(dir, 'jobs-2026-11-01.db')))
  for (const day of ['02', '03', '04', '05', '06', '07', '08', '09']) writeFileSync(join(dir, `jobs-2026-11-${day}.db`), 'old', { mode: 0o644 })
  writeFileSync(join(dir, 'notes.txt'), 'not a copy', { mode: 0o644 })
  const { clock } = clockRig(db, base.dir)
  clock.start()
  await clock.idle()
  const left = readdirSync(dir).filter((name) => name.startsWith('jobs-')).sort()
  assert.equal(left.length, BACKUP_KEEP)
  assert.deepEqual(left, ['jobs-2026-11-04.db', 'jobs-2026-11-05.db', 'jobs-2026-11-06.db', 'jobs-2026-11-07.db', 'jobs-2026-11-08.db', 'jobs-2026-11-09.db', 'jobs-2026-11-14.db'].slice(-BACKUP_KEEP))
  for (const name of left) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name)
  assert.ok(existsSync(join(dir, 'notes.txt')), 'only the copies are pruned')
  await clock.stop()
})

test('a copy that fails is logged, and the next round tries again', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  writeFileSync(join(base.dir, 'backups'), 'a file where the folder goes')
  const { clock, log } = clockRig(db, base.dir)
  clock.start()
  await clock.idle()
  assert.ok(log.lines.some((line) => line.startsWith('error') && line.includes('backup')))
  await clock.stop()
})

test('today’s copy already on disk but not remembered (a crash, a failed write) is replaced by a fresh one, not refused forever', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const dir = join(base.dir, 'backups')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'jobs-2026-11-14.db'), 'a partial copy')
  const { clock, log } = clockRig(db, base.dir)
  clock.start()
  await clock.idle()
  assert.deepEqual(log.lines.filter((line) => line.startsWith('error')), [])
  assert.ok(statSync(join(dir, 'jobs-2026-11-14.db')).size > 'a partial copy'.length, 'a real copy')
  assert.equal(db.read((q) => repo.getMeta(q, 'lastBackupDay')), '2026-11-14')
  await clock.stop()
})

test('a prune that fails is logged, and the day’s copy still counts as taken', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const dir = join(base.dir, 'backups')
  // A folder with a copy's name: chmod works on it, rmSync without `recursive` does not.
  for (const day of ['01', '02', '03', '04', '05', '06', '07']) mkdirSync(join(dir, `jobs-2026-11-${day}.db`), { recursive: true })
  const { clock, log } = clockRig(db, base.dir)
  clock.start()
  await clock.idle()
  assert.ok(log.lines.some((line) => line.startsWith('error') && line.includes('prune')))
  assert.equal(db.read((q) => repo.getMeta(q, 'lastBackupDay')), '2026-11-14')
  await clock.stop()
})

test(`after ${BACKUP_FAILURES_FLAG} copies failed in a row the store says so (meta, for health), and a good copy clears it`, async () => {
  using base = tempBase()
  const db = await queueStore(base)
  writeFileSync(join(base.dir, 'backups'), 'a file where the folder goes')
  const { clock, log, timers } = clockRig(db, base.dir)
  clock.start()
  await clock.idle()
  for (let i = 1; i < BACKUP_FAILURES_FLAG; i += 1) {
    assert.equal(db.read((q) => repo.getMeta(q, BACKUP_FAILING)), undefined, `not after ${i}`)
    timers.tick(CLOCK_MS)
    await clock.idle()
  }
  assert.match(db.read((q) => repo.getMeta(q, BACKUP_FAILING)) ?? '', /^2026-11-14T00:00:00.000Z/)
  assert.ok(log.lines.some((line) => line.includes(`${BACKUP_FAILURES_FLAG} times in a row`)))
  rmSync(join(base.dir, 'backups'))
  timers.tick(CLOCK_MS)
  await clock.idle()
  assert.equal(db.read((q) => repo.getMeta(q, BACKUP_FAILING)), undefined)
  await clock.stop()
})

test('wave 2 is remembered only when every CV was queued: a refused one is tried again next round', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  heldDraft(db, 'a', '2026-11-15')
  let refuse = true
  const { clock, timers } = clockRig(db, base.dir, {
    enqueueCv: (q, id) => {
      if (refuse) return { ok: false, error: { code: 'module-error', reason: 'refused' } }
      const app = repo.getApplication(q, id)!
      return repo.saveApplication(q, { ...app, state: 'generating' }, { kind: 'prepared' }, NOW)
    },
  })
  clock.start()
  await clock.idle()
  assert.equal(stateOf(db, 'a'), 'draft')
  refuse = false
  timers.tick(CLOCK_MS)
  await clock.idle()
  assert.equal(stateOf(db, 'a'), 'generating', 'not an hour later: the next round')
  await clock.stop()
})

test('R13: wave 2 — the CV of a held draft is queued once holdUntil − 7 d ≤ today, hourly; not before, not another file', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  heldDraft(db, 'due', '2026-11-21')
  heldDraft(db, 'later', '2026-11-22')
  heldDraft(db, 'other', '2026-11-15', 'by-hand.md#1')
  const { clock, timers, time } = clockRig(db, base.dir)
  clock.start()
  await clock.idle()
  assert.deepEqual(['due', 'later', 'other'].map((id) => stateOf(db, id)), ['generating', 'draft', 'draft'])
  assert.equal(db.read((q) => repo.genRequestsOf(q, 'due'))[0]?.kind, 'cv')

  // The 15th in Sydney: `later` is due, but the task runs hourly.
  time.set('2026-11-14T13:30:00.000Z')
  timers.tick(CLOCK_MS)
  await clock.idle()
  assert.equal(stateOf(db, 'later'), 'generating', 'an hour after the last run')
  heldDraft(db, 'late-import', '2026-11-16')
  time.advance(CLOCK_MS)
  timers.tick(CLOCK_MS)
  await clock.idle()
  assert.equal(stateOf(db, 'late-import'), 'draft', 'not within the hour')
  time.advance(HOUR)
  timers.tick(CLOCK_MS)
  await clock.idle()
  assert.equal(stateOf(db, 'late-import'), 'generating')
  await clock.stop()
})

test('wave 2: a CV the queue refuses is logged and the rest are still queued', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  heldDraft(db, 'a', '2026-11-15')
  heldDraft(db, 'b', '2026-11-15')
  const { clock, log } = clockRig(db, base.dir, {
    enqueueCv: (q, id) => {
      if (id === 'a') return { ok: false, error: { code: 'module-error', reason: 'refused' } }
      const app = repo.getApplication(q, id)!
      repo.setGenRequest(q, id, 'cv', 'w')
      return repo.saveApplication(q, { ...app, state: 'generating' }, { kind: 'prepared' }, NOW)
    },
  })
  clock.start()
  await clock.idle()
  assert.deepEqual([stateOf(db, 'a'), stateOf(db, 'b')], ['draft', 'generating'])
  assert.ok(log.lines.some((line) => line.startsWith('error') && line.includes('refused')))
  await clock.stop()
})
