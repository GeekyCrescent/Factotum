import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { appOf, eventsOf, insertApp, queueStore, SEED_ARTIFACTS } from '../ai/test-queue.ts'
import { valueOf } from '../test-state.ts'
import { capturedLog, realTimers, tempBase } from '../test-support.ts'
import { fail, type Warning } from '../types.ts'
import { DOC, MASTER } from './test-cv.ts'
import { APP_ID, builderDeps, builderRig, builderStore, FAKE_CLAUDE, GUIDE, runDir, runQueue, scriptClaude } from './test-builder.ts'
import { checkIt, createVerifier, unsupportedWarnings, type VerifierDeps } from './verify.ts'

const NOW = new Date('2026-11-14T00:00:00.000Z')
const ctx = { signal: new AbortController().signal, timeoutMs: 30_000 }
const LETTER = 'Dear team,\n\nI led a team of 12 at Northwind.\n\n{signature}'
const UNSUPPORTED = { unsupported: [{ where: 'letter', claim: 'led a team of 12', why: 'cv-maestro names no team size' }] }

function verifierDeps(stateDir: string, over: Partial<VerifierDeps> = {}): VerifierDeps {
  return {
    stateDir,
    timers: realTimers,
    now: () => NOW,
    log: capturedLog().log,
    sources: () => ({ ok: true, value: { master: MASTER, guide: GUIDE } }),
    claude: { model: 'sonnet', effort: undefined, bin: FAKE_CLAUDE },
    ...over,
  }
}

const calls = (stateDir: string): number => {
  const file = join(runDir(stateDir), 'fake-claude.calls')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0
}

test('each unsupported claim is an `unsupported-claim` that blocks, where it was found; the master CV goes as the system file', async () => {
  using base = tempBase()
  scriptClaude(base.dir, ['usage'], [UNSUPPORTED])
  const checked = await createVerifier(verifierDeps(base.dir))({ cv: DOC, letter: LETTER, origin: 'generated' }, ctx)

  assert.ok(checked.ok)
  assert.deepEqual(checked.warnings, [
    { code: 'unsupported-claim', where: 'letter', detail: 'led a team of 12 — cv-maestro names no team size', blocks: true, overridden: null },
  ])
  assert.equal(checked.usage?.cacheReadTokens, 35263)
  const args = JSON.parse(readFileSync(join(runDir(base.dir), 'fake-claude.args.1'), 'utf8')) as string[]
  assert.match(readFileSync(args[args.indexOf('--append-system-prompt-file') + 1]!, 'utf8'), /<cv-maestro>[\s\S]*Billing service/)
  assert.match(args[args.indexOf('--json-schema') + 1]!, /unsupported/)
  const stdin = readFileSync(join(runDir(base.dir), 'fake-claude.prompt.1'), 'utf8')
  assert.ok(stdin.includes('Built a billing service used by 40 teams') && stdin.includes('I led a team of 12'))
  assert.ok(!stdin.includes('Billing service: 40 teams'), 'the master CV never goes by stdin')
})

test('nothing unsupported: no warning', async () => {
  using base = tempBase()
  scriptClaude(base.dir, ['ok'], [{ unsupported: [] }])
  const checked = await createVerifier(verifierDeps(base.dir))({ cv: DOC, letter: null, origin: 'rewritten' }, ctx)
  assert.deepEqual(checked.ok && checked.warnings, [])
})

test('the seed’s texts are never checked (they passed the check of 2026-11-10): zero runs of Claude', async () => {
  using base = tempBase()
  scriptClaude(base.dir, ['ok'], [UNSUPPORTED])
  const checked = await createVerifier(verifierDeps(base.dir))({ cv: null, letter: LETTER, origin: 'seed' }, ctx)
  assert.deepEqual(checked, { ok: true, warnings: [], usage: null })
  const empty = await createVerifier(verifierDeps(base.dir))({ cv: null, letter: null, origin: 'generated' }, ctx)
  assert.deepEqual(empty, { ok: true, warnings: [], usage: null })
  assert.equal(calls(base.dir), 0)
})

test('more than ten claims is outside the schema: a failed check, never a partial one', async () => {
  using base = tempBase()
  const eleven = Array.from({ length: 11 }, (_, i) => ({ where: 'cv', claim: `claim ${i}`, why: 'not there' }))
  scriptClaude(base.dir, ['ok'], [{ unsupported: eleven }])
  const checked = await createVerifier(verifierDeps(base.dir))({ cv: DOC, letter: null, origin: 'generated' }, ctx)
  assert.deepEqual(checked, { ok: false, kind: 'failed', reason: 'claude answered outside the schema' })
})

test('a limit is a limit, and sources that cannot be read are a failed check', async () => {
  using base = tempBase()
  scriptClaude(base.dir, ['limit'])
  const limited = await createVerifier(verifierDeps(base.dir))({ cv: DOC, letter: null, origin: 'generated' }, ctx)
  assert.equal(!limited.ok && limited.kind, 'limit')
  const unread = await createVerifier(verifierDeps(base.dir, { sources: () => fail('module-error', 'cv-maestro.md is gone') }))(
    { cv: DOC, letter: null, origin: 'generated' },
    ctx,
  )
  assert.deepEqual(unread, { ok: false, kind: 'failed', reason: 'cv-maestro.md is gone' })
})

test('unsupportedWarnings is pure and keeps the detail short', () => {
  const long = 'x'.repeat(200)
  const [warning] = unsupportedWarnings([{ where: 'cv', claim: long, why: long }])
  assert.equal(warning?.detail.length, 403)
})

test('the CV builder with the real verifier: a claim the master CV does not back sends the application to review', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'], [DOC, { unsupported: [{ where: 'cv', claim: 'used by 40 teams', why: 'cv-maestro says 4' }] }])
  const verify = createVerifier(verifierDeps(base.dir))
  const { queue } = builderRig(db, builderDeps(db, base.dir, { verify }), { pdfExists: existsSync })
  await runQueue(queue)

  const app = appOf(db, APP_ID)
  assert.equal(app.state, 'in-review')
  assert.deepEqual(
    app.warnings.map((w) => [w.code, w.where, w.blocks]),
    [['unsupported-claim', 'cv', true]],
  )
  assert.equal(calls(base.dir), 2, 'one run writes, one checks')
})

// ── «I checked it» ───────────────────────────────────────────────────────────────────────────────

const claim = (detail: string): Warning => ({ code: 'unsupported-claim', where: 'cv', detail, blocks: true, overridden: null })
const WITH_PDF = { ...SEED_ARTIFACTS, pdf: '/state/artifacts/app-1/v1/cv.pdf' }
const SECRET_DETAIL = 'used by 40 teams — cv-maestro says 4'

test('«I checked it» overrides every `unsupported-claim`, the application becomes ready, and the event carries the code, never the text', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const gap: Warning = { code: 'requirement-gap', where: 'ad', detail: 'Kubernetes', blocks: false, overridden: null }
  insertApp(db, { state: 'in-review', warnings: [claim(SECRET_DETAIL), claim('another'), gap] }, WITH_PDF)
  valueOf(db.tx((q) => checkIt(q, { applicationId: 'app-1', codes: ['unsupported-claim'], pdfExists: () => true }, NOW)))

  const app = appOf(db, 'app-1')
  assert.equal(app.state, 'ready')
  assert.deepEqual(
    app.warnings.map((w) => w.overridden),
    [{ at: NOW.toISOString() }, { at: NOW.toISOString() }, null],
  )
  const override = eventsOf(db, 'app-1').filter((e) => e.kind === 'override')
  assert.deepEqual(
    override.map((e) => e.data),
    [{ codes: ['unsupported-claim'] }],
  )
  assert.ok(!JSON.stringify(eventsOf(db, 'app-1')).includes('40 teams'), 'no event carries the claim')
})

test('«I checked it» leaves the application in review while another block remains, and without its PDF', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const name: Warning = { code: 'confidential-name', where: 'cv', detail: 'IMSS', blocks: true, overridden: null }
  insertApp(db, { state: 'in-review', warnings: [claim('x'), name] }, WITH_PDF)
  valueOf(db.tx((q) => checkIt(q, { applicationId: 'app-1', codes: ['unsupported-claim'], pdfExists: () => true }, NOW)))
  assert.equal(appOf(db, 'app-1').state, 'in-review')

  using other = tempBase()
  const db2 = await queueStore(other)
  insertApp(db2, { state: 'in-review', warnings: [claim('x')] }, WITH_PDF)
  valueOf(db2.tx((q) => checkIt(q, { applicationId: 'app-1', codes: ['unsupported-claim'], pdfExists: () => false }, NOW)))
  assert.equal(appOf(db2, 'app-1').state, 'in-review', 'never ready without its PDF on disk')
})

test('«I checked it» also serves `external-link`, and is refused for any other code, an unknown application, a state out of review, or nothing to check', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const link: Warning = { code: 'external-link', where: 'letter', detail: 'evil.example', blocks: true, overridden: null }
  insertApp(db, { state: 'ready', warnings: [link] }, WITH_PDF)
  valueOf(db.tx((q) => checkIt(q, { applicationId: 'app-1', codes: ['external-link'], pdfExists: () => true }, NOW)))
  assert.notEqual(appOf(db, 'app-1').warnings[0]?.overridden, null)

  const refused = (applicationId: string, code: Warning['code']) =>
    db.tx((q) => checkIt(q, { applicationId, codes: [code], pdfExists: () => true }, NOW))
  const codeOf = (r: ReturnType<typeof refused>) => (r.ok ? 'ok' : r.error.code)
  assert.equal(codeOf(refused('app-1', 'confidential-name')), 'invalid')
  assert.equal(codeOf(refused('nobody', 'unsupported-claim')), 'not-found')
  assert.equal(codeOf(refused('app-1', 'unsupported-claim')), 'conflict', 'nothing left to check')
  db.tx((q) => {
    q.run(`UPDATE applications SET state = 'sent'`)
    return { ok: true, value: undefined }
  })
  assert.equal(codeOf(refused('app-1', 'external-link')), 'conflict')
})
