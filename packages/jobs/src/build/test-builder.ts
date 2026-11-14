/**
 * Test-only pieces of the CV builder's tests (H5a, H5b, L3): a store with a real profile and a rule,
 * an application queued for its CV, and the fake binaries wired in. ALL SYNTHETIC (see `test-cv.ts`).
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createQueue, type LintFn, type Queue, type QueueDeps } from '../ai/queue.ts'
import { queueStore, insertApp } from '../ai/test-queue.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { NOW, valueOf } from '../test-state.ts'
import { capturedLog, realTimers, type CapturedLog, type TempBase } from '../test-support.ts'
import { ok, type CvDoc } from '../types.ts'
import { createCvHandler, type CvBuilderDeps, type VerifyFn, type VerifyTarget } from './cv.ts'
import { DOC, MASTER, PROFILE } from './test-cv.ts'

const FIXTURES = new URL('../../test/fixtures/', import.meta.url)
const fixture = (name: string): string => {
  const path = fileURLToPath(new URL(name, FIXTURES))
  chmodSync(path, 0o755)
  return path
}
export const FAKE_CLAUDE = fixture('fake-claude.mjs')
export const FAKE_CHROMIUM = fixture('fake-chromium.mjs')
export const FAKE_PDFINFO = fixture('fake-pdfinfo.mjs')
export const FAKE_PDFTOPPM = fixture('fake-pdftoppm.mjs')

export const GUIDE = '# Guide\nCut the master CV to one page.'
export const RULE_TEXT = 'Always lead with the cloud work.'
export const APP_ID = 'app-1'

/** The store of `queueStore`, with `PROFILE` as version 2 and one enabled rule. */
export async function builderStore(base: TempBase): Promise<Db> {
  const db = await queueStore(base)
  valueOf(
    db.tx((q) => {
      repo.insertProfileVersion(q, { version: 2, createdAt: NOW.toISOString(), profile: PROFILE }, { kind: 'profile-saved' }, NOW)
      repo.insertRule(q, { id: 'rule-1', text: RULE_TEXT, scope: 'all', enabled: true, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }, { kind: 'rule-saved' }, NOW)
      return ok(undefined)
    }),
  )
  insertApp(db)
  return db
}

/** Where `runClaude` runs, so where fake-claude reads its modes and answers. */
export const runDir = (stateDir: string): string => join(stateDir, 'run')

/** fake-claude's script: `modes` one per call; `answers[i]` is call i+1's structured output. */
export function scriptClaude(stateDir: string, modes: readonly string[], answers: readonly unknown[] = [DOC]): void {
  const dir = runDir(stateDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'fake-claude.modes'), `${modes.join('\n')}\n`)
  answers.forEach((answer, i) => writeFileSync(join(dir, `fake-claude.answer.${i + 1}`), JSON.stringify(answer)))
}

/** fake-chromium's script: one mode per print (`pages=2`, `fail`…). */
export function scriptChromium(stateDir: string, ...modes: string[]): void {
  mkdirSync(join(stateDir, 'chromium'), { recursive: true })
  writeFileSync(join(stateDir, 'chromium', 'fake-chromium.modes'), `${modes.join('\n')}\n`)
}

/** Not Geist: four bytes are enough for a `data:` URI the fake printer never reads. */
export const FONT = new Uint8Array([0x77, 0x4f, 0x46, 0x32])

export interface SpyVerify {
  readonly verify: VerifyFn
  readonly calls: VerifyTarget[]
}

/** A verifier that records what it was given and answers `outcome` (by default: nothing unsupported). */
export function spyVerify(outcome: Awaited<ReturnType<VerifyFn>> = { ok: true, warnings: [], usage: null }): SpyVerify {
  const calls: VerifyTarget[] = []
  return {
    calls,
    verify: async (target) => {
      calls.push(target)
      return outcome
    },
  }
}

export const SHORT_DOC: CvDoc = { ...DOC, summary: 'Engineer.', experience: [] }

export function builderDeps(db: Db, stateDir: string, over: Partial<CvBuilderDeps> = {}): CvBuilderDeps {
  return {
    db,
    stateDir,
    now: () => NOW,
    timers: realTimers,
    log: capturedLog().log,
    sources: () => ok({ master: MASTER, guide: GUIDE, bases: { A: 'Base CV A.' } }),
    claude: { model: 'sonnet', effort: undefined, bin: FAKE_CLAUDE },
    font: FONT,
    chromium: FAKE_CHROMIUM,
    poppler: { pdfinfo: FAKE_PDFINFO, pdftoppm: FAKE_PDFTOPPM },
    verify: spyVerify().verify,
    ...over,
  }
}

export interface BuilderRig {
  readonly queue: Queue
  readonly log: CapturedLog
}

/** A queue whose `cv` handler is the builder; `APP_ID` queued for its CV. */
export function builderRig(db: Db, deps: CvBuilderDeps, over: Partial<QueueDeps> = {}): BuilderRig {
  const log = capturedLog()
  const lint: LintFn = () => []
  const queue = createQueue({
    db,
    now: () => NOW,
    concurrency: 2,
    handlers: { cv: createCvHandler(deps) },
    log: log.log,
    lint,
    relintOne: () => ok(undefined),
    pdfExists: () => true,
    ...over,
  })
  valueOf(db.tx((q) => queue.enqueueCv(q, APP_ID)))
  return { queue, log }
}

/** Runs the queue until nothing is running. */
export async function runQueue(queue: Queue): Promise<void> {
  queue.pump()
  await queue.settled()
}

export const onlyWork = (db: Db): repo.Work => {
  const [row] = db.read((q) => q.all<{ id: string }>('SELECT id FROM work'))
  const work = row === undefined ? undefined : db.read((q) => repo.getWork(q, row.id))
  if (work === undefined) throw new Error('no work')
  return work
}
