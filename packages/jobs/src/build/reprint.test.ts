/**
 * H5c — the reprint (design D5 «Reimpresión», D10 `reprint`, D3 «`cv-stale`»): D5 steps 5–7 again with
 * the SAME `CvDoc` and today's profile, no Claude; a new version `origin: 'reprinted'` with the new
 * `contactHash`, then the re-lint (T-A5). Over the real queue, its guard (G4), the real linter (L4) and
 * the fake printer (fake-chromium, fake-pdfinfo, fake-pdftoppm).
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { createQueue, type JobHandler, type Queue } from '../ai/queue.ts'
import { appOf, eventsOf, insertApp, queueStore, workOf } from '../ai/test-queue.ts'
import { printer } from '../facade/sources.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { NOW, valueOf } from '../test-state.ts'
import { capturedLog, manualClock, realTimers, tempBase, type ManualClock, type TempBase } from '../test-support.ts'
import { ok, type Artifacts, type Profile, type Warning } from '../types.ts'
import { createLinter } from './relint.ts'
import { contactHashOf, renderCvHtml } from './render.ts'
import { createReprintHandler, retryPrint } from './reprint.ts'
import { ARTIFACTS, DOC, MASTER, PROFILE } from './test-cv.ts'
import { FAKE_CHROMIUM, FAKE_PDFINFO, FAKE_PDFTOPPM, FONT, runDir, scriptChromium } from './test-builder.ts'

const MINUTE = 60_000
const NEW_PHONE = '+61 499 999 999'
const TODAY: Profile = { ...PROFILE, identity: { ...PROFILE.identity, phone: NEW_PHONE } }
/** Printed with the old phone: the version a contact change left out of date. */
const PRINTED: Artifacts = { ...ARTIFACTS, contactHash: contactHashOf(PROFILE) }
const STALE: Warning = { code: 'cv-stale', where: 'cv', detail: 'printed with another contact', blocks: true, overridden: null }
const OVERFLOW: Warning = { code: 'cv-overflow', where: 'cv', detail: 'the CV prints on 2 pages', blocks: true, overridden: null }
const CHECKED: Warning = { code: 'unsupported-claim', where: 'cv', detail: 'Led 12 people', blocks: true, overridden: { at: NOW.toISOString() } }

interface World {
  readonly db: Db
  readonly queue: Queue
  readonly clock: ManualClock
}

/** Profile version 2 is `TODAY` (the new phone); `app-1` is `in-review` with `cv-stale` over `PRINTED`. */
async function world(base: TempBase, app: Parameters<typeof insertApp>[1] = {}, artifacts: Artifacts = PRINTED, wrap?: (handler: JobHandler) => JobHandler): Promise<World> {
  const db = await queueStore(base)
  valueOf(db.tx((q) => ok(repo.insertProfileVersion(q, { version: 2, createdAt: NOW.toISOString(), profile: TODAY }, { kind: 'profile-saved' }, NOW))))
  insertApp(db, { state: 'in-review', warnings: [STALE], ...app }, artifacts)
  const clock = manualClock(NOW)
  const log = capturedLog().log
  const print = printer(db, { stateDir: base.dir, timers: realTimers, log, font: FONT, chromium: FAKE_CHROMIUM, poppler: { pdfinfo: FAKE_PDFINFO, pdftoppm: FAKE_PDFTOPPM } })
  const linter = createLinter({ master: () => ok(MASTER), pdfExists: () => true })
  const handler = createReprintHandler({ db, print, relintOne: linter.relintOne })
  const queue = createQueue({ db, now: clock.now, concurrency: 2, handlers: { reprint: wrap === undefined ? handler : wrap(handler) }, log, lint: linter.lint, relintOne: linter.relintOne, pdfExists: () => true })
  return { db, queue, clock }
}

const current = (db: Db, id = 'app-1'): Artifacts => {
  const app = appOf(db, id)
  const artifacts = db.read((q) => repo.getArtifacts(q, id, app.version))
  if (artifacts === undefined) assert.fail('no artifacts')
  return artifacts
}
const prints = (stateDir: string): number => {
  const file = join(stateDir, 'chromium', 'fake-chromium.calls')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0
}
const reprintWorks = (db: Db): readonly repo.Work[] =>
  db.read((q) => q.all<{ id: string }>(`SELECT id FROM work WHERE kind = 'reprint' ORDER BY id`)).map((row) => workOf(db, row.id))

async function reprint(w: World): Promise<string> {
  const id = valueOf(w.queue.add({ kind: 'reprint', ref: 'app-1' })).id
  await w.queue.settled()
  return id
}

test('H5c: a reprint prints the same CvDoc with today’s contact — a new version, reprinted, ready, and no Claude', async () => {
  using base = tempBase()
  const w = await world(base)

  await reprint(w)

  const app = appOf(w.db, 'app-1')
  assert.deepEqual([app.state, app.version, app.warnings], ['ready', 2, []], 'T-A5: the re-lint took cv-stale away')
  const artifacts = current(w.db)
  assert.equal(artifacts.origin, 'reprinted')
  assert.deepEqual(artifacts.cv, DOC, 'the text of the CV does not change')
  assert.deepEqual(artifacts.letter, PRINTED.letter)
  assert.equal(artifacts.contactHash, contactHashOf(TODAY))
  assert.equal(artifacts.profileVersion, 2)
  assert.equal(artifacts.usage, null, 'no Claude, nothing spent')
  assert.equal(artifacts.pdf, join(base.dir, 'artifacts', 'app-1', 'v2', 'cv.pdf'))
  assert.ok(existsSync(artifacts.pdf ?? '') && existsSync(artifacts.png ?? ''))
  const html = readFileSync(join(base.dir, 'chromium', 'fake-chromium.html.1'), 'utf8')
  assert.equal(html, renderCvHtml(DOC, TODAY, FONT).html, 'deterministic: the same doc and contact give the same HTML')
  assert.ok(html.includes(NEW_PHONE))
  assert.equal(existsSync(join(runDir(base.dir), 'fake-claude.calls')), false, 'fake-claude never ran')
  assert.deepEqual(eventsOf(w.db, 'app-1').filter((e) => e.kind === 'relinted').map((e) => e.data), [{ from: 'in-review', to: 'ready', codes: [] }])
})

test('H5c: a reprint that no longer fits one page is cv-overflow, with no «shorter» (that is Claude)', async () => {
  using base = tempBase()
  const w = await world(base)
  scriptChromium(base.dir, 'pages=2')

  await reprint(w)

  const app = appOf(w.db, 'app-1')
  assert.equal(app.state, 'in-review')
  assert.deepEqual(app.warnings.map((x) => x.code), ['cv-overflow'], 'the contact is current; the page count blocks')
  assert.equal(prints(base.dir), 1, 'printed once')
  assert.equal(current(w.db).contactHash, contactHashOf(TODAY))
})

test('H5c: a reprint on one page clears an old cv-overflow and keeps the verifier’s warning with its «I checked it»', async () => {
  using base = tempBase()
  const w = await world(base, { warnings: [STALE, OVERFLOW, CHECKED] })

  await reprint(w)

  const app = appOf(w.db, 'app-1')
  assert.deepEqual(app.warnings, [CHECKED])
  assert.equal(app.state, 'ready')
})

test('H5c: a reprint overtaken by a newer request of class cv is discarded (G4)', async () => {
  using base = tempBase()
  const w = await world(base)
  const id = valueOf(w.queue.add({ kind: 'reprint', ref: 'app-1' })).id
  // A newer cv request of this application, written while the reprint runs.
  valueOf(w.db.tx((q) => ok(repo.setGenRequest(q, 'app-1', 'cv', 'newer-work'))))
  await w.queue.settled()

  assert.equal(appOf(w.db, 'app-1').version, 1, 'nothing kept')
  assert.ok(eventsOf(w.db, 'app-1').some((e) => e.kind === 'prepared' && e.data.discarded === true && e.data.workId === id))
})

test('H5c: a reprint that fails three times leaves cv-stale, a reprint-failed event, and «Retry print» queues another', async () => {
  using base = tempBase()
  const w = await world(base)
  scriptChromium(base.dir, 'fail', 'fail', 'fail', 'pages=1')

  const first = valueOf(w.queue.add({ kind: 'reprint', ref: 'app-1' })).id
  for (let i = 0; i < 3; i += 1) {
    await w.queue.settled()
    w.clock.advance(10 * MINUTE)
    w.queue.pump()
  }
  await w.queue.settled()

  assert.equal(workOf(w.db, first).state, 'failed')
  const app = appOf(w.db, 'app-1')
  assert.deepEqual([app.state, app.version, app.warnings.map((x) => x.code)], ['in-review', 1, ['cv-stale']])
  const failed = eventsOf(w.db, 'app-1').filter((e) => e.kind === 'reprint-failed')
  assert.equal(failed.length, 1)
  assert.match(String(failed[0]?.data.reason), /print failed/)
  assert.equal(reprintWorks(w.db).length, 1, 'a failed reprint does not queue itself again')

  // «Retry print»: another reprint, and it comes back.
  valueOf(w.db.tx((q) => retryPrint(q, w.queue.enqueue, 'app-1')))
  w.queue.pump()
  await w.queue.settled()
  assert.equal(appOf(w.db, 'app-1').state, 'ready')
})

test('H5c: «Retry print» only for an unsent application with cv-stale and no reprint pending', async () => {
  using base = tempBase()
  const w = await world(base)
  insertApp(w.db, { id: 'clean', state: 'ready', warnings: [] }, { ...PRINTED, contactHash: contactHashOf(TODAY) })
  insertApp(w.db, { id: 'approved', state: 'approved', warnings: [STALE] }, PRINTED)

  const retry = (id: string) => w.db.tx((q) => retryPrint(q, w.queue.enqueue, id))
  assert.equal(retry('nope').ok, false)
  assert.equal(retry('clean').ok, false, 'nothing out of date')
  assert.equal(retry('approved').ok, false, 'only in-review or ready')
  assert.equal(retry('app-1').ok, true)
  const again = retry('app-1')
  assert.ok(!again.ok && again.error.code === 'conflict', 'one is already queued')
})

test('H5c: an application no longer in review, or whose contact is current again, is not reprinted', async () => {
  using base = tempBase()
  const w = await world(base, { state: 'closed' })
  insertApp(w.db, { id: 'reverted', state: 'ready', warnings: [] }, { ...PRINTED, contactHash: contactHashOf(TODAY) })

  await reprint(w)
  valueOf(w.queue.add({ kind: 'reprint', ref: 'reverted' }))
  await w.queue.settled()

  assert.equal(prints(base.dir), 0)
  assert.equal(appOf(w.db, 'app-1').version, 1)
  assert.equal(appOf(w.db, 'reverted').version, 1)
  assert.ok(reprintWorks(w.db).every((work) => work.state === 'done'))
})

test('H5c: a contact saved again while the reprint printed queues another reprint, which prints the newest', async () => {
  using base = tempBase()
  const NEWEST: Profile = { ...PROFILE, identity: { ...PROFILE.identity, phone: '+61 411 111 111' } }
  let saved = false
  const w = await world(base, {}, PRINTED, (handler) => async (work, ctx) => {
    const result = await handler(work, ctx)
    if (!saved) {
      saved = true
      valueOf(w.db.tx((q) => ok(repo.insertProfileVersion(q, { version: 3, createdAt: NOW.toISOString(), profile: NEWEST }, { kind: 'profile-saved' }, NOW))))
    }
    return result
  })

  await reprint(w)
  await w.queue.settled()

  assert.equal(reprintWorks(w.db).length, 2)
  const app = appOf(w.db, 'app-1')
  assert.deepEqual([app.state, app.version], ['ready', 3])
  assert.equal(current(w.db).contactHash, contactHashOf(NEWEST))
})

test('H5c: a reprint whose contact is current again re-lints instead — cv-stale clears, and no other reprint is queued', async () => {
  using base = tempBase()
  // The owner changed the contact back while the re-lint was skipped (vault offline): `cv-stale` stayed
  // on a CV printed with today's contact.
  let runs = 0
  const w = await world(base, {}, { ...PRINTED, contactHash: contactHashOf(TODAY) }, (handler) => async (work, ctx) => {
    runs += 1
    // A loop guard for the red run: past a few, a failure (which never queues another) ends it.
    return runs > 3 ? { ok: false, kind: 'failed', reason: 'looping' } : handler(work, ctx)
  })

  await reprint(w)
  await w.queue.settled()

  assert.equal(runs, 1, 'one run, no reprint queued after a no-op')
  assert.equal(reprintWorks(w.db).length, 1)
  assert.equal(prints(base.dir), 0, 'nothing printed')
  const app = appOf(w.db, 'app-1')
  assert.deepEqual([app.state, app.version, app.warnings], ['ready', 1, []], 'the re-lint took cv-stale away')
})
