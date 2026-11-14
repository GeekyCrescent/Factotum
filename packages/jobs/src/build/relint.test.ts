import assert from 'node:assert/strict'
import { test } from 'node:test'

import { appOf, controlled, eventsOf, insertApp, insertFollowup, queueStore, rig } from '../ai/test-queue.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { BLOCKER, NOW, errorOf, followupVersion, valueOf } from '../test-state.ts'
import { capturedLog, tempBase, type TempBase } from '../test-support.ts'
import { fail, ok, type Artifacts, type Profile, type Warning } from '../types.ts'
import { contactHashOf } from './render.ts'
import { createLinter, saveProfileRelinting, saveRuleRelinting, type Linter } from './relint.ts'
import { ARTIFACTS, MASTER, PROFILE } from './test-cv.ts'

const HASH = contactHashOf(PROFILE)
/** A printed version every linter rule passes: the CV of `test-cv.ts`, printed with today's contact. */
const CLEAN: Artifacts = { ...ARTIFACTS, contactHash: HASH }

const found = (code: Warning['code'], where: Warning['where'], overridden: Warning['overridden'] = null, blocks = true): Warning => ({
  code,
  where,
  detail: `${code} detail`,
  blocks,
  overridden,
})

async function store(base: TempBase, profile: Profile = PROFILE): Promise<Db> {
  const db = await queueStore(base)
  valueOf(
    db.tx((q) => {
      repo.insertProfileVersion(q, { version: 2, createdAt: NOW.toISOString(), profile }, { kind: 'profile-saved' }, NOW)
      return ok(undefined)
    }),
  )
  return db
}

const linter = (over: Partial<Parameters<typeof createLinter>[0]> = {}): Linter =>
  createLinter({ master: () => ok(MASTER), pdfExists: () => true, ...over })

const relinted = (db: Db, id: string) => eventsOf(db, id).filter((e) => e.kind === 'relinted')

test('L4: an in-review application whose only block was the linter\'s goes ready, with one relinted event', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { state: 'in-review', warnings: [BLOCKER] }, CLEAN)

  const report = valueOf(db.tx((q) => linter().relintUnsent(q, NOW)))

  assert.equal(appOf(db, 'app-1').state, 'ready')
  assert.deepEqual(appOf(db, 'app-1').warnings, [])
  assert.equal(report.relinted, 1)
  assert.deepEqual(report.reprint, [])
  const [event] = relinted(db, 'app-1')
  assert.deepEqual(event?.data, { from: 'in-review', to: 'ready', codes: [] })
})

test('L4: the found warnings stay with their overridden — verifier, ad, cv-overflow, requirement-gap, external-link', async () => {
  using base = tempBase()
  const db = await store(base)
  const at = { at: NOW.toISOString() }
  const kept = [
    found('unsupported-claim', 'cv', at),
    found('cv-overflow', 'cv', at),
    found('ad-closed', 'ad', at),
    found('requirement-gap', 'ad', null, false),
  ]
  const link = 'https://elsewhere.example/apply'
  const withLink: Artifacts = { ...CLEAN, letter: { subject: 'Hi', body: `See ${link}.\n\n{signature}` } }
  const checked: Warning = { code: 'external-link', where: 'letter', detail: link, blocks: true, overridden: at }
  insertApp(db, { state: 'ready', warnings: [...kept, checked] }, withLink)

  valueOf(db.tx((q) => linter().relintUnsent(q, NOW)))

  const app = appOf(db, 'app-1')
  assert.equal(app.state, 'ready', 'every block is overridden')
  for (const w of [...kept, checked]) assert.ok(app.warnings.some((x) => x.code === w.code && x.overridden?.at === w.overridden?.at), `${w.code} kept`)
  assert.deepEqual(relinted(db, 'app-1'), [], 'nothing changed: no event')
})

test('L4: a ready application that gains a block goes back to in-review', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { state: 'ready' }, { ...CLEAN, letter: { subject: 'Hi', body: 'I worked at Acme Hospital.\n\n{signature}' } })

  const report = valueOf(db.tx((q) => linter().relintUnsent(q, NOW)))

  const app = appOf(db, 'app-1')
  assert.equal(app.state, 'in-review')
  assert.deepEqual(app.warnings.map((w) => w.code), ['confidential-name'])
  assert.equal(report.relinted, 1)
  assert.deepEqual(relinted(db, 'app-1')[0]?.data, { from: 'ready', to: 'in-review', codes: ['confidential-name'] })
})

test('L4: draft, generating, rewriting and approved are skipped', async () => {
  using base = tempBase()
  const db = await store(base)
  for (const [id, state] of [['d', 'draft'], ['g', 'generating'], ['r', 'rewriting'], ['a', 'approved']] as const) {
    insertApp(db, { id, state, warnings: [BLOCKER], rewriteFrom: state === 'rewriting' ? 'in-review' : null }, CLEAN)
  }

  const report = valueOf(db.tx((q) => linter().relintUnsent(q, NOW)))

  assert.equal(report.relinted, 0)
  for (const id of ['d', 'g', 'r', 'a']) assert.deepEqual(appOf(db, id).warnings, [BLOCKER], `${id} untouched`)
})

test('L4: the PDF gone from disk takes a ready application to in-review with missing-cv', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { state: 'ready' }, CLEAN)

  valueOf(db.tx((q) => linter({ pdfExists: () => false }).relintUnsent(q, NOW)))

  const app = appOf(db, 'app-1')
  assert.equal(app.state, 'in-review')
  assert.deepEqual(app.warnings.map((w) => w.code), ['missing-cv'])
})

test('L4: a CV printed with another contact gains cv-stale and is named for a reprint, once', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { state: 'ready' }, { ...CLEAN, contactHash: 'printed-with-another-phone' })
  insertApp(db, { id: 'already', state: 'in-review', warnings: [found('cv-stale', 'cv')] }, { ...CLEAN, contactHash: 'old' })

  const report = valueOf(db.tx((q) => linter().relintUnsent(q, NOW)))

  assert.equal(appOf(db, 'app-1').state, 'in-review')
  assert.deepEqual(report.reprint, ['app-1'], 'only the one that GAINED cv-stale')
})

test('L4: an unsent follow-up is re-linted with the follow-up profile (T-F2), both ways', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { state: 'sent' }, CLEAN)
  insertFollowup(db, { id: 'fu-ready', state: 'ready', versions: [followupVersion(1, { body: 'Hi Ada, following up. {signature} [x]' })] })
  insertFollowup(db, { id: 'fu-draft', n: 2, state: 'draft', warnings: [BLOCKER], versions: [followupVersion(1, { body: 'Hi Ada,\n\nFollowing up.\n\n{signature}' })] })

  const report = valueOf(db.tx((q) => linter().relintUnsent(q, NOW)))

  const rows = db.read((q) => ({ ready: repo.getFollowup(q, 'fu-ready'), draft: repo.getFollowup(q, 'fu-draft') }))
  assert.equal(rows.ready?.state, 'draft')
  assert.ok(rows.ready?.warnings.some((w) => w.code === 'placeholder'))
  assert.equal(rows.draft?.state, 'ready')
  assert.equal(report.relinted, 2)
})

test('L4: a master CV that cannot be read (the vault offline) skips each application, logged and reported; the profile and a rule still save', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { id: 'a', state: 'in-review', warnings: [BLOCKER] }, CLEAN)
  insertApp(db, { id: 'b', state: 'ready' }, CLEAN)
  insertFollowup(db, { id: 'fu-draft', applicationId: 'a', state: 'draft', warnings: [BLOCKER], versions: [followupVersion(1, { body: 'Hi Ada,\n\nFollowing up.\n\n{signature}' })] })
  const broken = linter({ master: () => fail('module-error', 'cv master: cannot read (ENOENT)') })
  const log = capturedLog()
  const deps = { now: () => NOW, linter: broken, log: log.log, newId: () => 'rule-1', enqueueReprint: () => assert.fail('no reprint') }

  const saved = valueOf(saveProfileRelinting(db, { ...PROFILE, identity: { ...PROFILE.identity, phone: '+61 499 999 999' } }, deps))

  assert.equal(saved.version, 3, 'the profile saved')
  assert.deepEqual([saved.relinted, saved.skipped], [1, 2], 'the follow-up re-linted; both applications skipped')
  assert.deepEqual(appOf(db, 'a').warnings, [BLOCKER], 'a skipped row keeps its warnings')
  assert.equal(appOf(db, 'b').state, 'ready')
  assert.deepEqual(relinted(db, 'b'), [])
  assert.deepEqual(log.lines.filter((line) => line.startsWith('warn')).length, 2)
  assert.ok(log.lines.every((line) => !line.startsWith('warn') || line.includes('cv master: cannot read (ENOENT)')))

  const rule = valueOf(saveRuleRelinting(db, { text: 'Always be brief.', scope: 'all' }, deps))
  assert.deepEqual([rule.id, rule.skipped], ['rule-1', 2])
})

test('L4: an application whose company is gone is skipped by the re-lint; the others still re-lint', async () => {
  using base = tempBase()
  const db = await store(base)
  // A damaged store: the foreign keys are off only to write the orphan.
  db.read((q) => q.run('PRAGMA foreign_keys = OFF'))
  insertApp(db, { id: 'orphan', state: 'in-review', warnings: [BLOCKER], opportunityId: 'nope' }, CLEAN)
  db.read((q) => q.run('PRAGMA foreign_keys = ON'))
  insertApp(db, { id: 'fine', state: 'in-review', warnings: [BLOCKER] }, CLEAN)

  const report = valueOf(db.tx((q) => linter().relintUnsent(q, NOW)))

  assert.equal(report.relinted, 1)
  assert.deepEqual(report.skipped, [{ kind: 'application', id: 'orphan', reason: 'application orphan has no opportunity or company' }])
  assert.equal(appOf(db, 'fine').state, 'ready')
  assert.deepEqual(appOf(db, 'orphan').warnings, [BLOCKER])
})

test('L4: saving the profile re-lints in its tx; the reprint hook runs after it, once per application', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { id: 'a', state: 'ready' }, CLEAN)
  insertApp(db, { id: 'b', state: 'ready' }, CLEAN)
  const reprinted: string[] = []
  const inTx: boolean[] = []

  const saved = valueOf(
    saveProfileRelinting(db, { ...PROFILE, identity: { ...PROFILE.identity, phone: '+61 499 999 999' } }, {
      now: () => NOW,
      linter: linter(),
      enqueueReprint: (id) => {
        // After the tx: a new tx can open (inside one it would be refused).
        inTx.push(!db.tx(() => ok(undefined)).ok)
        reprinted.push(id)
      },
    }),
  )

  assert.equal(saved.version, 3)
  assert.equal(saved.relinted, 2)
  assert.deepEqual(reprinted.sort(), ['a', 'b'])
  assert.deepEqual(inTx, [false, false])
  assert.equal(appOf(db, 'a').state, 'in-review')
})

test('L4: a reprint hook that throws is logged, and the save stands', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { state: 'ready' }, CLEAN)
  const log = capturedLog()

  const saved = saveProfileRelinting(db, { ...PROFILE, identity: { ...PROFILE.identity, phone: '+61 499 999 999' } }, {
    now: () => NOW,
    linter: linter(),
    log: log.log,
    enqueueReprint: () => {
      throw new Error('queue stopped')
    },
  })

  assert.equal(valueOf(saved).version, 3)
  assert.ok(log.lines.some((line) => line.startsWith('error') && line.includes('app-1') && line.includes('queue stopped')))
})

test('L4: an invalid profile is refused before any tx', async () => {
  using base = tempBase()
  const db = await store(base)
  errorOf(saveProfileRelinting(db, { nope: true }, { now: () => NOW, linter: linter(), enqueueReprint: () => undefined }), 'invalid')
})

test('L4: saving a rule (new or edited) re-lints in its tx', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { state: 'in-review', warnings: [BLOCKER] }, CLEAN)
  const deps = { now: () => NOW, newId: () => 'rule-1', linter: linter(), enqueueReprint: () => undefined }

  const created = valueOf(saveRuleRelinting(db, { text: 'Always be brief.', scope: 'all' }, deps))
  assert.equal(created.id, 'rule-1')
  assert.equal(created.relinted, 1)
  assert.equal(appOf(db, 'app-1').state, 'ready')

  const edited = valueOf(saveRuleRelinting(db, { enabled: false }, deps, 'rule-1'))
  assert.equal(edited.enabled, false)
  assert.equal(edited.relinted, 0)
  errorOf(saveRuleRelinting(db, { enabled: false }, deps, 'nope'), 'not-found')
})

test('L4 + G4: a CV that comes back on a ready application is re-linted by the queue with the real linter (L1)', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { state: 'ready' }, CLEAN)
  const handler = controlled()
  const real = linter()
  const { queue } = rig(db, { handlers: { cv: handler.handler }, lint: real.lint, relintOne: real.relintOne })
  const work = valueOf(queue.add({ kind: 'cv', ref: 'app-1' }))
  await new Promise((resolve) => setImmediate(resolve))

  const kafka = { ...CLEAN.cv!, summary: 'Engineer who ships Kafka pipelines.' }
  handler.finish(work.id, { ok: true, output: { type: 'application', artifacts: { cv: kafka, profileVersion: 2, rules: [], usage: null, origin: 'generated' } } })
  await queue.settled()

  const app = appOf(db, 'app-1')
  assert.equal(app.version, 2, 'kept as a version')
  assert.equal(app.state, 'in-review', 'the real linter saw the forbidden stack')
  assert.deepEqual(app.warnings.map((w) => w.code), ['forbidden-stack'])
})

test('L4 + G4: the queue\'s lint of a returned generation is L1 over the store, follow-ups by their profile', async () => {
  using base = tempBase()
  const db = await store(base)
  const app = insertApp(db, { state: 'generating' }, CLEAN)
  const row = insertFollowup(db, { state: 'rewriting', rewriteFrom: 'ready' })
  const real = linter()

  const warnings = db.read((q) => ({
    app: real.lint(q, { kind: 'application', application: app, artifacts: { ...CLEAN, letter: { subject: 'x', body: '[TODO] {signature}' } } }, NOW),
    followup: real.lint(q, { kind: 'followup', followup: row, version: followupVersion(2, { body: 'Hi [name]' }) }, NOW),
  }))

  assert.ok(warnings.app.some((w) => w.code === 'placeholder' && w.where === 'letter'))
  assert.ok(warnings.followup.some((w) => w.code === 'placeholder' && w.where === 'followup'))
  assert.throws(() => db.read((q) => linter({ master: () => fail('module-error', 'gone') }).lint(q, { kind: 'application', application: app, artifacts: CLEAN }, NOW)), /gone/)
})

test('L4: relintOne of an application or follow-up not in a re-lint state is a no-op; an unknown id is not-found', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { state: 'sent' }, CLEAN)
  insertFollowup(db, { state: 'sent' })
  const real = linter()

  valueOf(db.tx((q) => real.relintOne(q, { kind: 'application', id: 'app-1' }, NOW)))
  valueOf(db.tx((q) => real.relintOne(q, { kind: 'followup', id: 'fu-1' }, NOW)))
  errorOf(db.tx((q) => real.relintOne(q, { kind: 'application', id: 'nope' }, NOW)), 'not-found')
  errorOf(db.tx((q) => real.relintOne(q, { kind: 'followup', id: 'nope' }, NOW)), 'not-found')
  assert.deepEqual(relinted(db, 'app-1'), [])
})

test('L4: an in-review application with no version yet lints as empty: missing-cv, never ready', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { state: 'in-review', version: 0, warnings: [found('missing-cv', 'cv')] }, null)

  valueOf(db.tx((q) => linter().relintUnsent(q, NOW)))

  const app = appOf(db, 'app-1')
  assert.equal(app.state, 'in-review')
  assert.ok(app.warnings.some((w) => w.code === 'missing-cv'))
})
