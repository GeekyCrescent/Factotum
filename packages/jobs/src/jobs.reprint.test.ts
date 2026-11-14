/**
 * H5c — the reprint end to end, through the facade (v5 X5, moved from E1; design D5, T-A5, T-A6): import
 * with one phone, the CV printed and `ready`; save ANOTHER phone → `cv-stale` and `in-review`, approve →
 * `blocked`; the reprint comes back → `ready` with the new `contactHash`; approve → the mail the fake
 * SMTP got carries the signature AND the PDF with the new phone, and `sends.profile_version` is the new
 * version. The real queue, builder, reprint, linter and sender; fake claude, chromium and poppler.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { SendInput, SendResult } from '@factotum/mail'

import { contactHashOf } from './build/render.ts'
import type { ApplicationCard, Jobs } from './facade/types.ts'
import { openDb, type Db } from './store/db.ts'
import * as repo from './store/repo.ts'
import { depsOf, NOW, rigIn, started } from './test-jobs.ts'
import { errorOf, valueOf } from './test-state.ts'
import { eventually, tempBase } from './test-support.ts'

const NEW_PHONE = '+61 499 999 999'

const claudeCalls = (stateDir: string): number => {
  const file = join(stateDir, 'run', 'fake-claude.calls')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0
}

/** The undecided email application of the open batch, with the `seen` the screen would send. */
function emailItem(jobs: Jobs, id?: string): { readonly itemId: string; readonly seen: string; readonly card: ApplicationCard } {
  const batch = valueOf(jobs.batch()).batch
  if (batch === null) assert.fail('a batch')
  for (const item of batch.items) {
    if (item.kind !== 'application') continue
    if (id === undefined ? item.application.channel === 'email' && item.application.state === 'ready' : item.application.id === id) {
      return { itemId: item.itemId, seen: item.seen, card: item.application }
    }
  }
  return assert.fail('an email application in the batch')
}

const stateOf = (jobs: Jobs, id: string): string => valueOf(jobs.application(id)).application.state

test('H5c end to end: another phone → cv-stale, approve blocked; the reprint comes back ready; the mail carries the new phone', async () => {
  using base = tempBase()
  const rig = rigIn(base.dir)
  // Every print puts its HTML in the "PDF", so the attachment can be read for the contact it carries.
  mkdirSync(join(rig.stateDir, 'chromium'), { recursive: true })
  writeFileSync(join(rig.stateDir, 'chromium', 'fake-chromium.modes'), 'html\n')
  const mails: SendInput[] = []
  const sendMail = async (input: SendInput): Promise<SendResult> => {
    mails.push(input)
    return { ok: true, messageId: input.messageId, response: '250 2.0.0 OK' }
  }
  const jobs = await started(depsOf(rig, { sendMail }))
  try {
    // 1. Imported with one phone: the CVs printed and ready.
    valueOf(await jobs.importSeed({ dryRun: false }))
    await eventually(() => (jobs.overview().byState.generating ?? 0) === 0, 'every CV came back', 30_000)
    valueOf(jobs.startBatch())
    const { card } = emailItem(jobs)
    const id = card.id
    const old = jobs.profile()
    assert.notEqual(old.profile.identity.phone, NEW_PHONE)
    const claudeBefore = claudeCalls(rig.stateDir)

    // 2. Another phone: cv-stale and in-review (T-A6); approving it is refused.
    const saved = valueOf(jobs.saveProfile({ ...old.profile, identity: { ...old.profile.identity, phone: NEW_PHONE } }))
    assert.ok(saved.relinted > 0)
    const stale = valueOf(jobs.application(id)).application
    assert.equal(stale.state, 'in-review')
    assert.ok(stale.warnings.some((w) => w.code === 'cv-stale'))
    assert.equal(stale.jobs.reprint.state, 'pending', 'the card says «reprinting with your new contact…»')
    const blocked = emailItem(jobs, id)
    errorOf(jobs.decide({ itemId: blocked.itemId, kind: 'approve', addressOverride: true, seen: blocked.seen }), 'blocked')
    assert.equal(mails.length, 0)

    // 3. The reprint comes back: ready (T-A5), the same text, the new contact, and no Claude.
    await eventually(() => stateOf(jobs, id) === 'ready', 'the reprint came back', 30_000)
    const back = valueOf(jobs.application(id)).application
    assert.ok(back.version > stale.version)
    assert.equal(back.jobs.reprint.state, 'idle')
    assert.equal(claudeCalls(rig.stateDir), claudeBefore, 'a reprint runs no Claude')

    // 4. Approved: the mail has the signature and the PDF with the new phone.
    const ready = emailItem(jobs, id)
    assert.equal(valueOf(jobs.decide({ itemId: ready.itemId, kind: 'approve', addressOverride: true, seen: ready.seen })).result, 'approved')
    await eventually(() => mails.length === 1 && stateOf(jobs, id) === 'sent', 'the mail went', 30_000)
    const [mail] = mails
    assert.ok(mail?.text.includes(NEW_PHONE), 'the signature carries the new phone')
    assert.ok(!mail?.text.includes(old.profile.identity.phone))
    const pdf = mail?.attachment?.content.toString('utf8') ?? ''
    assert.ok(pdf.startsWith('%PDF-fake') && pdf.includes(NEW_PHONE), 'the PDF carries the new phone')
    assert.ok(!pdf.includes(old.profile.identity.phone))

    // 5. What the store says: the reprinted version, and the profile version the send used.
    const db = valueOf(await openDb({ dir: rig.stateDir, now: () => NOW }))
    try {
      const app = db.read((q) => repo.getApplication(q, id))
      const artifacts = app === undefined ? undefined : db.read((q) => repo.getArtifacts(q, id, app.version))
      assert.equal(artifacts?.origin, 'reprinted')
      assert.equal(artifacts?.contactHash, contactHashOf(jobs.profile().profile))
      assert.deepEqual((app?.sends ?? []).map((s) => [s.kind, s.profileVersion, s.artifactsVersion]), [['initial', saved.version, back.version]])
    } finally {
      db.close()
    }
  } finally {
    await jobs.stop()
  }
})

/** A second handle on `jobs.db`, beside the running facade (as the CLI does). */
async function withStore<T>(stateDir: string, read: (db: Db) => T): Promise<T> {
  const db = valueOf(await openDb({ dir: stateDir, now: () => NOW }))
  try {
    return read(db)
  } finally {
    db.close()
  }
}

const reprintOf = (db: Db, id: string): repo.Work | undefined =>
  db.read((q) => q.all<{ id: string }>(`SELECT id FROM work WHERE kind = 'reprint' AND ref = ? ORDER BY created_at, rowid`, id).map((row) => repo.getWork(q, row.id)).at(-1))

test('H5c «Retry print» through the facade: refused while a reprint is pending; after a failed one, another that comes back', async () => {
  using base = tempBase()
  const rig = rigIn(base.dir)
  const jobs = await started(depsOf(rig))
  const modes = join(rig.stateDir, 'chromium', 'fake-chromium.modes')
  try {
    valueOf(await jobs.importSeed({ dryRun: false }))
    await eventually(() => (jobs.overview().byState.generating ?? 0) === 0, 'every CV came back', 30_000)
    valueOf(jobs.startBatch())
    const id = emailItem(jobs).card.id
    writeFileSync(modes, 'fail\n')

    const profile = jobs.profile().profile
    valueOf(jobs.saveProfile({ ...profile, identity: { ...profile.identity, phone: NEW_PHONE } }))
    errorOf(jobs.retry(id, 'reprint'), 'conflict', 'the CV is being printed already')
    // The first attempt fails and waits its 2 minutes, which this test's clock never reaches.
    await eventually(async () => (await withStore(rig.stateDir, (db) => reprintOf(db, id)))?.attempts === 1, 'the first attempt failed', 30_000)

    // Given up, as after its third attempt: the card says why and offers «Retry print».
    await withStore(rig.stateDir, (db) =>
      db.tx((q) => {
        const work = reprintOf(db, id)
        if (work === undefined) assert.fail('a reprint')
        return repo.saveWork(q, { ...work, state: 'failed', notBefore: null })
      }),
    )
    const failedJob = valueOf(jobs.application(id)).application.jobs.reprint
    assert.equal(failedJob.state, 'failed')
    assert.match(failedJob.reason ?? '', /print failed/)
    const stuck = emailItem(jobs, id)
    errorOf(jobs.decide({ itemId: stuck.itemId, seen: stuck.seen, kind: 'approve', addressOverride: true }), 'blocked')

    writeFileSync(modes, 'html\n')
    assert.deepEqual(valueOf(jobs.retry(id, 'reprint')), { queued: ['reprint'] })
    assert.equal(valueOf(jobs.application(id)).application.jobs.reprint.state, 'pending')
    await eventually(() => stateOf(jobs, id) === 'ready', 'the retried reprint came back', 30_000)
    errorOf(jobs.retry(id, 'reprint'), 'conflict', 'the CV carries the contact of today already')
  } finally {
    await jobs.stop()
  }
})
