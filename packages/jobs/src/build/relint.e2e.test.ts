/**
 * L4b — the blocker of v2: NOTHING REACHES `ready` WITHOUT A CV (design D3, D6, D8; R11, R13b, R21).
 * End to end: the fixture seed imported for real (S5–S6), the queue and its guard (G4), the CV builder
 * with fake-claude, fake-chromium and fake-pdfinfo (H5a, H5b), the linter (L1) and the re-lint (L4).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { createQueue, type Queue } from '../ai/queue.ts'
import { importSeed } from '../seed/import.ts'
import { ADS, context, DEFAULT_PACKAGES, fixture, NOW, seedProfile, storeWith, vaultOf, WAVE1, WAVE2 } from '../seed/test-seed.ts'
import { appTransition } from '../state.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { valueOf } from '../test-state.ts'
import { capturedLog, tempBase, type TempBase } from '../test-support.ts'
import { ok, type Application, type Profile } from '../types.ts'
import { createCvHandler } from './cv.ts'
import { createLinter, saveProfileRelinting, type Linter } from './relint.ts'
import { builderDeps, GUIDE, runDir } from './test-builder.ts'
import { DOC, MASTER } from './test-cv.ts'

interface World {
  readonly db: Db
  readonly queue: Queue
  readonly linter: Linter
  readonly save: (profile: Profile) => number
}

async function world(base: TempBase): Promise<World> {
  const db = await storeWith(base, seedProfile())
  const texts = await Promise.all([ADS, WAVE1, WAVE2, 'companies.json', 'kit.md'].map(fixture))
  const master = [MASTER, ...texts].join('\n')
  // fake-claude answers every call with this CV.
  const run = runDir(base.dir)
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'fake-claude.answer'), JSON.stringify(DOC))
  const deps = builderDeps(db, base.dir, { sources: () => ok({ master, guide: GUIDE, bases: { A: 'Base CV A.' } }) })
  const linter = createLinter({ master: () => ok(master), pdfExists: existsSync })
  const queue = createQueue({ db, now: () => NOW, concurrency: 4, handlers: { cv: createCvHandler(deps) }, log: capturedLog().log, lint: linter.lint, relintOne: linter.relintOne, pdfExists: existsSync })
  valueOf(await importSeed(db, context({ vault: vaultOf(DEFAULT_PACKAGES), enqueueCv: queue.enqueueCv }), { dryRun: false }))
  const save = (profile: Profile): number => valueOf(saveProfileRelinting(db, profile, { now: () => NOW, linter, enqueueReprint: () => assert.fail('no contact changed') })).relinted
  return { db, queue, linter, save }
}

const ALL: readonly Application['state'][] = ['draft', 'generating', 'in-review', 'ready', 'rewriting', 'approved', 'sending', 'sent', 'closed']
const apps = (db: Db): readonly Application[] => db.read((q) => repo.applicationsByState(q, ALL))
const inState = (db: Db, state: Application['state']): readonly Application[] => apps(db).filter((a) => a.state === state)
const appOf = (db: Db, id: string): Application => {
  const app = db.read((q) => repo.getApplication(q, id))
  if (app === undefined) assert.fail(`no ${id}`)
  return app
}
const pdfOf = (db: Db, app: Application): string => {
  const pdf = db.read((q) => repo.getArtifacts(q, app.id, app.version))?.pdf
  if (pdf === null || pdf === undefined) assert.fail(`${app.id} has no PDF`)
  return pdf
}

test('L4b: nothing reaches ready without its CV — import, a re-lint, the CV back, the PDF gone, a Skip, a Retry', async () => {
  using base = tempBase()
  const w = await world(base)

  // 1. Imported with a phone and nothing else blocking: draft or generating, never ready.
  const states = new Set(apps(w.db).map((a) => a.state))
  assert.deepEqual([...states].sort(), ['draft', 'generating'])
  const generating = inState(w.db, 'generating').map((a) => a.id)
  assert.ok(generating.length > 0)

  // 2. A re-lint (the profile saved) touches neither draft nor generating.
  assert.equal(w.save(seedProfile()), 0)
  assert.deepEqual(inState(w.db, 'generating').map((a) => a.id), generating)
  for (const app of apps(w.db)) assert.equal(w.db.read((q) => repo.eventsOf(q, app.id)).some((e) => e.kind === 'relinted'), false)

  // 3. The CVs come back (fake-claude, fake-chromium, fake-pdfinfo): ready, each with its PDF on disk.
  w.queue.pump()
  await w.queue.settled()
  assert.equal(inState(w.db, 'generating').length, 0)
  const ready = inState(w.db, 'ready')
  assert.ok(ready.length > 0, 'the clean ones are ready')
  for (const app of ready) assert.ok(existsSync(pdfOf(w.db, app)), `${app.id}: ready with its PDF`)
  for (const app of inState(w.db, 'in-review')) assert.ok(!app.warnings.some((x) => x.code === 'missing-cv'), `${app.id}: in review for another block`)

  // 4. The PDF deleted from the disk: the re-lint takes it back to in-review with missing-cv.
  const [gone, skipped, ...rest] = ready
  if (gone === undefined || skipped === undefined) assert.fail('two ready applications are needed')
  rmSync(pdfOf(w.db, gone))
  assert.ok(w.save(seedProfile()) >= 1)
  const lost = appOf(w.db, gone.id)
  assert.equal(lost.state, 'in-review')
  assert.ok(lost.warnings.some((x) => x.code === 'missing-cv'))
  for (const app of rest) assert.equal(appOf(w.db, app.id).state, 'ready', 'the others keep their PDF')

  // 5. A CV that comes back after a «Skip» (not a fit) is kept as a version; the state does not move.
  valueOf(
    w.db.tx((q) => {
      const moved = appTransition(appOf(w.db, skipped.id), { type: 'skip-not-a-fit', reason: 'not-a-fit' }, NOW) // T-A22
      return moved.ok ? repo.saveApplication(q, moved.value, { kind: 'skipped', data: { reason: 'not-a-fit' } }, NOW) : moved
    }),
  )
  valueOf(w.queue.add({ kind: 'cv', ref: skipped.id }))
  await w.queue.settled()
  const after = appOf(w.db, skipped.id)
  assert.equal(after.state, 'closed')
  assert.equal(after.version, skipped.version + 1, 'saved as a version')

  // 6. A CV whose request a «Retry» overtook is discarded; the Retry's own comes back and counts.
  const overtaken = valueOf(w.db.tx((q) => w.queue.enqueue(q, { kind: 'cv', ref: gone.id })))
  valueOf(w.db.tx((q) => w.queue.retry(q, gone.id))) // T-A4: a new cv request
  w.queue.pump()
  await w.queue.settled()
  const discarded = w.db.read((q) => repo.eventsOf(q, gone.id)).filter((e) => e.kind === 'prepared' && e.data.discarded === true)
  assert.deepEqual(
    discarded.map((e) => ({ kind: e.data.kind, workId: e.data.workId })),
    [{ kind: 'cv', workId: overtaken.id }],
  )
  assert.equal(appOf(w.db, gone.id).state, 'ready', 'the Retry printed it again')
})
