/**
 * H5c — the exits of `cv-stale` that are not a profile save (design D3 «`cv-stale`», v4 A6): an
 * application `generating` or `rewriting` while the contact changes is not re-linted then; its
 * `cv-stale` is looked at WHEN IT COMES BACK (T-A2, T-A8), and when it has one its reprint is queued.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { createLinter } from '../build/relint.ts'
import { contactHashOf } from '../build/render.ts'
import { createReprintHandler } from '../build/reprint.ts'
import { createCvHandler } from '../build/cv.ts'
import { APP_ID, builderDeps, builderStore, FAKE_CHROMIUM, FAKE_PDFINFO, FAKE_PDFTOPPM, FONT, scriptClaude } from '../build/test-builder.ts'
import { ARTIFACTS, MASTER, PROFILE } from '../build/test-cv.ts'
import { printer } from '../facade/sources.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { NOW, valueOf } from '../test-state.ts'
import { capturedLog, realTimers, tempBase, type TempBase } from '../test-support.ts'
import { ok, type Profile } from '../types.ts'
import { createQueue, instructionEvent, type JobHandler, type Queue, type QueueDeps } from './queue.ts'
import { appOf, insertApp } from './test-queue.ts'

const NEW: Profile = { ...PROFILE, identity: { ...PROFILE.identity, phone: '+61 499 999 999' } }

/** A contact save, as `saveProfile` writes it; the re-lint skips `generating` and `rewriting`. */
const saveContact = (db: Db, version: number, profile: Profile): void =>
  valueOf(db.tx((q) => ok(repo.insertProfileVersion(q, { version, createdAt: NOW.toISOString(), profile }, { kind: 'profile-saved' }, NOW))))

const kinds = (db: Db, id: string): readonly string[] =>
  db.read((q) => q.all<{ kind: string }>('SELECT kind FROM work WHERE ref = ? ORDER BY created_at, rowid', id)).map((row) => row.kind)

/** A queue with the real linter, the real CV builder and the real reprint (fake binaries). */
function queueOf(db: Db, base: TempBase, handlers: QueueDeps['handlers'] = {}): Queue {
  const log = capturedLog().log
  const print = printer(db, { stateDir: base.dir, timers: realTimers, log, font: FONT, chromium: FAKE_CHROMIUM, poppler: { pdfinfo: FAKE_PDFINFO, pdftoppm: FAKE_PDFTOPPM } })
  const linter = createLinter({ master: () => ok(MASTER), pdfExists: existsSync })
  return createQueue({
    db,
    now: () => NOW,
    concurrency: 2,
    handlers: { cv: createCvHandler(builderDeps(db, base.dir)), reprint: createReprintHandler({ db, print, relintOne: linter.relintOne }), ...handlers },
    log,
    lint: linter.lint,
    relintOne: linter.relintOne,
    pdfExists: existsSync,
  })
}

test('H5c: generating when the contact changes — the CV prints after, with the new contact, and comes back without cv-stale', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'])
  const queue = queueOf(db, base)
  valueOf(db.tx((q) => queue.enqueueCv(q, APP_ID)))
  saveContact(db, 3, NEW)

  queue.pump()
  await queue.settled()

  const app = appOf(db, APP_ID)
  assert.equal(app.state, 'ready')
  assert.equal(db.read((q) => repo.getArtifacts(q, APP_ID, app.version))?.contactHash, contactHashOf(NEW))
  assert.deepEqual(kinds(db, APP_ID), ['cv'], 'nothing to reprint')
})

test('H5c: generating, printed before the contact changed — back in-review with cv-stale, its reprint queued, then ready', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'])
  const cv: JobHandler = async (work, ctx) => {
    const result = await createCvHandler(builderDeps(db, base.dir))(work, ctx)
    saveContact(db, 3, NEW) // after the print, before the return
    return result
  }
  const queue = queueOf(db, base, { cv })
  valueOf(db.tx((q) => queue.enqueueCv(q, APP_ID)))
  queue.pump()
  await queue.settled()

  assert.deepEqual(kinds(db, APP_ID), ['cv', 'reprint'])
  const events = db.read((q) => repo.eventsOf(q, APP_ID))
  const back = events.find((e) => e.kind === 'prepared' && e.data.kind === 'cv' && e.data.version !== undefined)
  assert.ok(back !== undefined, 'the CV came back')
  const app = appOf(db, APP_ID)
  assert.equal(app.state, 'ready', 'the reprint came back (T-A5)')
  assert.ok(events.some((e) => e.kind === 'relinted' && e.data.from === 'in-review' && e.data.to === 'ready'), 'it went in-review with cv-stale first')
  assert.equal(db.read((q) => repo.getArtifacts(q, APP_ID, app.version))?.contactHash, contactHashOf(NEW))
})

test('H5c: rewriting when the contact changes, and the CV did not change — back with cv-stale, its reprint queued, then ready', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  const pdf = join(base.dir, 'artifacts', 'rw', 'v1', 'cv.pdf')
  mkdirSync(dirname(pdf), { recursive: true })
  writeFileSync(pdf, '%PDF-fake pages=1\n')
  insertApp(db, { id: 'rw', state: 'rewriting', rewriteFrom: 'ready', version: 1 }, { ...ARTIFACTS, pdf, contactHash: contactHashOf(PROFILE) })
  // The real rewrite of an unchanged CV brings the letter only (`review/rewrite.ts`, `changedOf`).
  const rewrite: JobHandler = async () => ({
    ok: true,
    output: { type: 'application', artifacts: { letter: { subject: 'Hi', body: 'Shorter.\n\n{signature}' }, profileVersion: 3, rules: [], usage: null, origin: 'rewritten' }, warnings: [] },
  })
  const queue = queueOf(db, base, { rewrite })
  valueOf(
    db.tx((q) => {
      const saved = repo.saveApplication(q, appOf(db, 'rw'), instructionEvent('Shorter.'), NOW)
      return saved.ok ? queue.enqueue(q, { kind: 'rewrite', ref: 'rw' }) : saved
    }),
  )
  saveContact(db, 3, NEW)

  queue.pump()
  await queue.settled()

  assert.deepEqual(kinds(db, 'rw'), ['rewrite', 'reprint'])
  const app = appOf(db, 'rw')
  assert.equal(app.state, 'ready', 'the reprint came back (T-A5)')
  const artifacts = db.read((q) => repo.getArtifacts(q, 'rw', app.version))
  assert.deepEqual([artifacts?.origin, artifacts?.contactHash, artifacts?.letter?.body], ['reprinted', contactHashOf(NEW), 'Shorter.\n\n{signature}'])
})

test('H5c: a work that writes no CV nor letter (a verify, a classify) never queues a reprint — a failed one waits for «Retry print»', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  const stale = { code: 'cv-stale', where: 'cv', detail: 'printed with another contact', blocks: true, overridden: null } as const
  insertApp(db, { id: 'st', state: 'in-review', warnings: [stale] }, { ...ARTIFACTS, contactHash: contactHashOf(PROFILE) })
  saveContact(db, 3, NEW)
  const queue = queueOf(db, base, { verify: async () => ({ ok: true, output: { type: 'apply', apply: () => ok(undefined) } }) })

  valueOf(queue.add({ kind: 'verify', ref: 'st' }))
  await queue.settled()

  assert.deepEqual(kinds(db, 'st'), ['verify'])
})
