/**
 * L4's two tests of the seed (v4, R16b), each with its own starting profile, and the third (the phone
 * deleted): the fixture packages imported for real (S5–S6), the CVs brought back by a fake handler,
 * the real linter (L1) as the queue's guard, and the re-lint of `saveProfile` (R15, R16b).
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { createQueue, type JobHandler, type JobResult, type Queue } from '../ai/queue.ts'
import { controlled } from '../ai/test-queue.ts'
import { importSeed } from '../seed/import.ts'
import { ADS, context, fixture, HOLD, NOW, readerWith, seedProfile, storeWith, vaultOf, WAVE1, WAVE2 } from '../seed/test-seed.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { valueOf } from '../test-state.ts'
import { capturedLog, eventually, tempBase, type TempBase } from '../test-support.ts'
import type { Application, Profile } from '../types.ts'
import { createLinter, saveProfileRelinting, type Linter } from './relint.ts'
import { contactHashOf } from './render.ts'
import { DOC, MASTER } from './test-cv.ts'

/** The ads go in a `byHand` file (no CV); wave 1 is the module's; wave 2 is held. */
const PACKAGES = [{ file: ADS, byHand: true }, { file: WAVE1 }, { file: WAVE2, holdUntil: HOLD }]

/** Wave 1 of the fixture, every letter carrying `{portfolio}` (as the owner's wave 1 does). */
async function waveWithPortfolio(): Promise<string> {
  return (await fixture(WAVE1)).replace(/^> Alex Example ·/gm, '> My work: {portfolio}\n>\n> Alex Example ·')
}

/** Every figure of the fixtures is in this «master CV», so the number rule is not what blocks. */
async function master(): Promise<string> {
  const texts = await Promise.all([ADS, WAVE1, WAVE2, 'companies.json', 'kit.md'].map(fixture))
  return [MASTER, ...texts].join('\n')
}

interface World {
  readonly db: Db
  readonly queue: Queue
  readonly linter: Linter
  readonly runs: () => number
  readonly reprints: string[]
  readonly save: (profile: Profile) => ReturnType<typeof saveProfileRelinting>
}

/** The CV as a run prints it: with the profile of that moment, its PDF really on disk. */
function printed(db: Db, pdf: string): JobResult {
  const current = db.read((q) => repo.latestProfileVersion(q))
  if (current === undefined) assert.fail('no profile')
  const artifacts = { cv: DOC, pdf, png: null, contactHash: contactHashOf(current.profile), profileVersion: current.version, rules: [], usage: null, origin: 'generated' as const }
  return { ok: true, output: { type: 'application', artifacts, warnings: [] } }
}

async function world(base: TempBase, profile: Profile, handler: (db: Db, pdf: string) => { readonly handler: JobHandler; readonly runs: () => number }): Promise<World> {
  const db = await storeWith(base, profile)
  const pdf = join(base.dir, 'cv.pdf')
  writeFileSync(pdf, '%PDF-1.4')
  const text = await master()
  const linter = createLinter({ master: () => ({ ok: true, value: text }), pdfExists: (path) => path === pdf })
  const cv = handler(db, pdf)
  const queue = createQueue({ db, now: () => NOW, concurrency: 8, handlers: { cv: cv.handler }, log: capturedLog().log, lint: linter.lint, relintOne: linter.relintOne, pdfExists: (path) => path === pdf })
  const wave = await waveWithPortfolio()
  valueOf(await importSeed(db, context({ vault: vaultOf(PACKAGES), readText: readerWith({ [WAVE1]: wave }), enqueueCv: queue.enqueueCv }), { dryRun: false }))
  const reprints: string[] = []
  const save = (next: Profile) => saveProfileRelinting(db, next, { now: () => NOW, linter, enqueueReprint: (id) => void reprints.push(id) })
  return { db, queue, linter, runs: cv.runs, reprints, save }
}

/** A handler that prints at once. */
function immediate(db: Db, pdf: string): { readonly handler: JobHandler; readonly runs: () => number } {
  let runs = 0
  return {
    runs: () => runs,
    handler: async () => {
      runs += 1
      return printed(db, pdf)
    },
  }
}

const apps = (db: Db): readonly Application[] =>
  db.read((q) => repo.applicationsByState(q, ['draft', 'generating', 'in-review', 'ready', 'approved', 'sent', 'closed']))
const byState = (db: Db, state: Application['state']): readonly Application[] => apps(db).filter((a) => a.state === state)
const blocksBesides = (app: Application, code: string): boolean => app.warnings.some((w) => w.blocks && w.overridden === null && w.code !== code)
const reprintWork = (db: Db): number => db.read((q) => q.all("SELECT id FROM work WHERE kind = 'reprint'").length)
const relintedEvents = (db: Db, id: string): number => db.read((q) => repo.eventsOf(q, id).filter((e) => e.kind === 'relinted').length)

test('L4 (1): a print field unblocks — the portfolio saved, those with no other block go ready in that tx, no Claude, no reprint', async () => {
  using base = tempBase()
  const handler = controlled()
  const w = await world(base, seedProfile({ portfolioUrl: '' }), () => ({ handler: handler.handler, runs: () => handler.calls.length }))
  const generating = byState(w.db, 'generating')
  assert.ok(generating.length >= 3, 'wave 1 is queued for its CVs')
  assert.equal(byState(w.db, 'ready').length, 0, 'nothing is ready while no CV is back')

  w.queue.pump()
  await eventually(() => handler.calls.length === generating.length, 'every CV run started')
  const [held, ...back] = handler.calls
  if (held === undefined) assert.fail('no run')
  const pdf = join(base.dir, 'cv.pdf')
  for (const work of back) handler.finish(work.id, printed(w.db, pdf))
  await eventually(() => byState(w.db, 'generating').length === 1, 'every CV but one came back')

  const reviewed = byState(w.db, 'in-review')
  assert.equal(reviewed.length, back.length, 'the returned ones are in review')
  for (const app of reviewed) assert.ok(app.warnings.some((x) => x.code === 'missing-portfolio'), `${app.id} waits for the portfolio`)
  assert.equal(byState(w.db, 'ready').length, 0)
  const unblockable = reviewed.filter((app) => !blocksBesides(app, 'missing-portfolio')).map((a) => a.id)
  assert.ok(unblockable.length > 0, 'at least one has nothing else blocking')
  const runsBefore = w.runs()

  const saved = valueOf(w.save(seedProfile({ portfolioUrl: 'https://alex.example.test/' })))

  assert.deepEqual(byState(w.db, 'ready').map((a) => a.id).sort(), [...unblockable].sort())
  assert.equal(saved.relinted, reviewed.length, 'every returned one lost its missing-portfolio')
  assert.equal(w.runs(), runsBefore, 'no Claude run')
  assert.deepEqual(w.reprints, [], 'the portfolio is not in the contact hash: no reprint')
  assert.equal(reprintWork(w.db), 0)
  const stillGenerating = byState(w.db, 'generating')
  assert.deepEqual(stillGenerating.map((a) => a.id), [held.ref], 'the generating one is not touched')
  assert.equal(relintedEvents(w.db, held.ref), 0)
  for (const app of byState(w.db, 'draft')) assert.equal(relintedEvents(w.db, app.id), 0, 'the held drafts are not touched')

  handler.finish(held.id, printed(w.db, pdf))
  await w.queue.settled()
})

test('L4 (2): a contact change asks for a reprint — another phone, every ready goes cv-stale and in-review, the hook once each after the tx', async () => {
  using base = tempBase()
  const w = await world(base, seedProfile(), immediate)
  w.queue.pump()
  await w.queue.settled()
  const ready = byState(w.db, 'ready').map((a) => a.id).sort()
  assert.ok(ready.length >= 3, 'printed with the phone, the portfolio set: they are ready')
  // The fixture keeps one letter with a TODO on purpose: printed too, but in review for its placeholder.
  const todo = byState(w.db, 'in-review')
  assert.ok(todo.every((a) => a.warnings.every((x) => x.code === 'placeholder')), 'nothing but the TODO keeps one back')
  const printedIds = [...ready, ...todo.map((a) => a.id)].sort()
  const runsBefore = w.runs()

  const saved = valueOf(w.save(seedProfile({ phone: '+61 400 111 222' })))

  assert.equal(byState(w.db, 'ready').length, 0)
  for (const app of byState(w.db, 'in-review')) assert.ok(app.warnings.some((x) => x.code === 'cv-stale'), `${app.id} is stale`)
  assert.deepEqual([...w.reprints].sort(), printedIds, 'the hook, once per printed application')
  assert.equal(saved.relinted, printedIds.length)
  assert.equal(w.runs(), runsBefore, 'no Claude run')
})

test('L4 (3): the phone deleted from the profile takes the ready ones to in-review with missing-phone', async () => {
  using base = tempBase()
  const w = await world(base, seedProfile(), immediate)
  w.queue.pump()
  await w.queue.settled()
  const ready = byState(w.db, 'ready').map((a) => a.id)
  assert.ok(ready.length > 0)

  valueOf(w.save(seedProfile({ phone: '' })))

  for (const id of ready) {
    const app = apps(w.db).find((a) => a.id === id)
    assert.equal(app?.state, 'in-review')
    assert.ok(app?.warnings.some((x) => x.code === 'missing-phone'), `${id} needs the phone`)
  }
})
