import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { appOf, eventsOf } from '../ai/test-queue.ts'
import { getArtifacts } from '../store/repo.ts'
import { tempBase } from '../test-support.ts'
import type { Artifacts, Warning } from '../types.ts'
import { SHORTER } from './cv.ts'
import { contactHashOf } from './render.ts'
import { DOC, PROFILE } from './test-cv.ts'
import {
  APP_ID,
  builderDeps,
  builderRig,
  builderStore,
  onlyWork,
  runDir,
  runQueue,
  scriptChromium,
  scriptClaude,
  SHORT_DOC,
  spyVerify,
} from './test-builder.ts'

const BLOCK: Warning = { code: 'confidential-name', where: 'cv', detail: 'Acme Hospital', blocks: true, overridden: null }
const UNSUPPORTED: Warning = { code: 'unsupported-claim', where: 'cv', detail: 'Led a team of 12 — not in cv-maestro', blocks: true, overridden: null }

const claudeCalls = (stateDir: string): number => {
  const file = join(runDir(stateDir), 'fake-claude.calls')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0
}
const chromiumHtml = (stateDir: string, n: number): string => readFileSync(join(stateDir, 'chromium', `fake-chromium.html.${n}`), 'utf8')

function built(db: Awaited<ReturnType<typeof builderStore>>): Artifacts {
  const app = appOf(db, APP_ID)
  const artifacts = db.read((q) => getArtifacts(q, APP_ID, app.version))
  if (artifacts === undefined) assert.fail('no artifacts')
  return artifacts
}

test('one page: printed with the profile’s contact, saved under artifacts/<id>/v<k>/ with its hash, verified, and ready', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'])
  const spy = spyVerify()
  const { queue } = builderRig(db, builderDeps(db, base.dir, { verify: spy.verify }), { pdfExists: existsSync })
  await runQueue(queue)

  const app = appOf(db, APP_ID)
  assert.deepEqual([app.state, app.version, app.warnings], ['ready', 2, []])
  const artifacts = built(db)
  const dir = join(base.dir, 'artifacts', APP_ID, 'v2')
  assert.deepEqual([artifacts.pdf, artifacts.png], [join(dir, 'cv.pdf'), join(dir, 'preview.png')])
  assert.ok(statSync(join(dir, 'cv.pdf')).size > 0 && existsSync(join(dir, 'preview.png')))
  assert.equal(artifacts.contactHash, contactHashOf(PROFILE))
  assert.ok(chromiumHtml(base.dir, 1).includes(PROFILE.identity.phone), 'the contact is the profile’s, printed by the template')
  assert.equal(claudeCalls(base.dir), 1)
  assert.deepEqual(spy.calls, [{ cv: DOC, letter: null, origin: 'generated' }], 'the verifier checks the CV this run wrote, not the seed’s letter')
  assert.ok(eventsOf(db, APP_ID).some((e) => e.kind === 'prepared' && e.data.version === 2 && e.data.kind === 'cv'))
  assert.equal(existsSync(join(base.dir, 'render', onlyWork(db).id)), false, 'the render folder is cleared')
})

test('two pages, then one: «shorter» once, with the previous CV and its instruction; the shorter CV is the one kept', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'], [DOC, SHORT_DOC])
  scriptChromium(base.dir, 'pages=2', 'pages=1')
  const spy = spyVerify()
  const { queue } = builderRig(db, builderDeps(db, base.dir, { verify: spy.verify }), { pdfExists: existsSync })
  await runQueue(queue)

  assert.equal(claudeCalls(base.dir), 2)
  const second = readFileSync(join(runDir(base.dir), 'fake-claude.prompt.2'), 'utf8')
  assert.ok(second.includes('<previous-cv>') && second.includes(`<instruction>${SHORTER}</instruction>`))
  const artifacts = built(db)
  assert.deepEqual(artifacts.cv, SHORT_DOC)
  assert.equal(readFileSync(artifacts.pdf!, 'utf8').trim(), '%PDF-fake pages=1')
  assert.equal(artifacts.usage?.costUsd, 0.0042, 'the cost of both runs')
  assert.equal(artifacts.usage?.outputTokens, 120)
  assert.deepEqual(spy.calls.map((c) => c.cv), [SHORT_DOC])
  assert.equal(appOf(db, APP_ID).state, 'ready')
})

test('two pages, then two: `cv-overflow` blocks, the PDF is kept, and «shorter» ran only once', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'], [DOC, SHORT_DOC])
  scriptChromium(base.dir, 'pages=2')
  const { queue } = builderRig(db, builderDeps(db, base.dir), { pdfExists: existsSync })
  await runQueue(queue)

  assert.equal(claudeCalls(base.dir), 2)
  const app = appOf(db, APP_ID)
  assert.equal(app.state, 'in-review')
  assert.deepEqual(app.warnings, [{ code: 'cv-overflow', where: 'cv', detail: 'the CV prints on 2 pages', blocks: true, overridden: null }])
  assert.ok(existsSync(built(db).pdf!))
})

test('step 4 → 5: a block of the linter still prints, previews and verifies; the application goes to review with both warnings', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'])
  const spy = spyVerify({ ok: true, warnings: [UNSUPPORTED], usage: null })
  const { queue } = builderRig(db, builderDeps(db, base.dir, { verify: spy.verify }), { lint: () => [BLOCK], pdfExists: existsSync })
  await runQueue(queue)

  const app = appOf(db, APP_ID)
  assert.equal(app.state, 'in-review')
  assert.deepEqual(app.warnings, [BLOCK, UNSUPPORTED])
  const artifacts = built(db)
  assert.ok(existsSync(artifacts.pdf!) && existsSync(artifacts.png!))
  assert.equal(spy.calls.length, 1)
})

test('the verifier’s usage is added to the version’s', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'])
  const usage = { inputTokens: 1, cacheCreationTokens: 2, cacheReadTokens: 3, outputTokens: 4, costUsd: 0.5, ms: 6, model: 'claude-sonnet' }
  const { queue } = builderRig(db, builderDeps(db, base.dir, { verify: spyVerify({ ok: true, warnings: [], usage }).verify }))
  await runQueue(queue)
  assert.equal(built(db).usage?.costUsd, 0.5021)
})

test('a verifier that could not run fails the attempt (the queue retries) — never an overridable warning, never a CV unchecked', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'])
  const verify = spyVerify({ ok: false, kind: 'failed', reason: 'claude gave no answer within 120 s' }).verify
  const { queue } = builderRig(db, builderDeps(db, base.dir, { verify }), { pdfExists: existsSync })
  await runQueue(queue)

  const work = onlyWork(db)
  assert.deepEqual([work.state, work.attempts, work.reason], ['queued', 1, 'the check did not run: claude gave no answer within 120 s'])
  const app = appOf(db, APP_ID)
  assert.deepEqual([app.state, app.version, app.warnings], ['generating', 1, []])
  assert.equal(existsSync(join(base.dir, 'artifacts', APP_ID, 'v2')), false, 'no version folder is kept for a CV that was not checked')
})

test('a verifier at the usage limit is a limit: no attempt counted', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'])
  const verify = spyVerify({ ok: false, kind: 'limit', reason: 'claude hit its usage limit' }).verify
  const { queue } = builderRig(db, builderDeps(db, base.dir, { verify }), { pdfExists: existsSync })
  await runQueue(queue)

  const work = onlyWork(db)
  assert.deepEqual([work.state, work.attempts, work.reason], ['queued', 0, 'claude hit its usage limit'])
})

test('Chromium failing is a failed attempt with its reason; nothing is saved', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'])
  scriptChromium(base.dir, 'fail')
  const { queue } = builderRig(db, builderDeps(db, base.dir))
  await runQueue(queue)

  const work = onlyWork(db)
  assert.deepEqual([work.state, work.attempts], ['queued', 1])
  assert.match(work.reason ?? '', /chromium/)
  assert.deepEqual([appOf(db, APP_ID).state, appOf(db, APP_ID).version], ['generating', 1])
})

test('a «shorter» run that fails fails the attempt: never a second print of a CV nobody wrote', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok', 'garbage'])
  scriptChromium(base.dir, 'pages=2')
  const { queue } = builderRig(db, builderDeps(db, base.dir))
  await runQueue(queue)
  assert.deepEqual([onlyWork(db).attempts, onlyWork(db).reason], [1, 'claude answered something that is not JSON'])
})

test('a version folder already there (a run discarded by the guard) is never written over: the next one is taken', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  mkdirSync(join(base.dir, 'artifacts', APP_ID, 'v2'), { recursive: true })
  scriptClaude(base.dir, ['ok'])
  const { queue } = builderRig(db, builderDeps(db, base.dir))
  await runQueue(queue)
  assert.equal(built(db).pdf, join(base.dir, 'artifacts', APP_ID, 'v3', 'cv.pdf'))
})
