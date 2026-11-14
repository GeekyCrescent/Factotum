import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { appOf, eventsOf } from '../ai/test-queue.ts'
import { getArtifacts } from '../store/repo.ts'
import { AUTH_PAUSE_MS } from '../ai/queue.ts'
import { NOW } from '../test-state.ts'
import { manualClock, tempBase } from '../test-support.ts'
import { fail, type Warning } from '../types.ts'
import { DOC } from './test-cv.ts'
import { APP_ID, builderDeps, builderRig, builderStore, GUIDE, onlyWork, RULE_TEXT, runDir, runQueue, scriptClaude } from './test-builder.ts'

const BLOCK: Warning = { code: 'confidential-name', where: 'cv', detail: 'Acme Hospital', blocks: true, overridden: null }

const callArgs = (stateDir: string, n: number): readonly string[] => JSON.parse(readFileSync(join(runDir(stateDir), `fake-claude.args.${n}`), 'utf8')) as string[]
const callPrompt = (stateDir: string, n: number): string => readFileSync(join(runDir(stateDir), `fake-claude.prompt.${n}`), 'utf8')

test('step 1: the fixed part goes as a system FILE, what changes by stdin — the rule, the base version and the letter included', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'])
  const { queue } = builderRig(db, builderDeps(db, base.dir))
  await runQueue(queue)

  const args = callArgs(base.dir, 1)
  const file = args[args.indexOf('--append-system-prompt-file') + 1]
  assert.ok(file !== undefined && file.startsWith(join(base.dir, 'prompts')), 'the master file lives under <stateDir>/prompts')
  assert.match(readFileSync(file, 'utf8'), /<cv-maestro>[\s\S]*Billing service[\s\S]*<guide>/)
  assert.ok(readFileSync(file, 'utf8').includes(GUIDE.split('\n')[1]!))
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet')
  const stdin = callPrompt(base.dir, 1)
  assert.ok(stdin.includes(`<rule>${RULE_TEXT}</rule>`), 'the owner’s rule is in the prompt')
  assert.ok(stdin.includes('<base-cv version="A">Base CV A.</base-cv>'))
  assert.ok(stdin.includes('<letter>Seed letter {signature}</letter>'), 'the current letter goes along')
  assert.ok(!stdin.includes('Billing service'), 'the master CV never goes by stdin')
})

test('steps 2–3: the CvDoc comes back validated and is saved as a new version with its profile version, rules and usage', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['usage'])
  const { queue } = builderRig(db, builderDeps(db, base.dir))
  await runQueue(queue)

  const app = appOf(db, APP_ID)
  assert.equal(app.version, 2)
  const artifacts = db.read((q) => getArtifacts(q, APP_ID, 2))
  assert.deepEqual(artifacts?.cv, DOC)
  assert.equal(artifacts?.profileVersion, 2)
  assert.deepEqual(artifacts?.rules, ['rule-1'])
  assert.equal(artifacts?.origin, 'generated')
  assert.equal(artifacts?.usage?.cacheReadTokens, 35263)
  assert.equal(artifacts?.usage?.costUsd, 0.0021)
  assert.equal(artifacts?.usage?.model, 'claude-haiku-4-5-20251001')
  assert.deepEqual(artifacts?.letter, { subject: 'Hello', body: 'Seed letter {signature}' }, 'what the CV run did not produce is kept')
  assert.equal(onlyWork(db).state, 'done')
})

test('an answer outside the CvDoc schema is a failed attempt: the work goes back to the queue and nothing is saved', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'], [{ headline: '', summary: 'x' }])
  const { queue } = builderRig(db, builderDeps(db, base.dir))
  await runQueue(queue)

  const work = onlyWork(db)
  assert.deepEqual([work.state, work.attempts, work.reason], ['queued', 1, 'claude answered outside the schema'])
  const app = appOf(db, APP_ID)
  assert.deepEqual([app.state, app.version], ['generating', 1])
})

test('step 4: a block of the linter does not cut the run — the CV is kept and the application goes to review with it', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['ok'])
  const { queue } = builderRig(db, builderDeps(db, base.dir), { lint: () => [BLOCK] })
  await runQueue(queue)

  const app = appOf(db, APP_ID)
  assert.equal(app.state, 'in-review')
  assert.deepEqual(app.warnings, [BLOCK])
  assert.deepEqual(db.read((q) => getArtifacts(q, APP_ID, app.version))?.cv, DOC)
  assert.ok(eventsOf(db, APP_ID).some((e) => e.kind === 'prepared' && e.data.version === 2))
})

test('a usage limit comes back as a limit: no attempt counted, the queue pauses', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['limit-exit1'])
  const { queue } = builderRig(db, builderDeps(db, base.dir))
  await runQueue(queue)

  const work = onlyWork(db)
  assert.deepEqual([work.state, work.attempts], ['queued', 0])
  assert.notEqual(queue.pausedUntil(), null)
})

test('a CV that meets a logged-out CLI twice and then answers goes to review, never missing-cv', async () => {
  // Arrange
  using base = tempBase()
  const db = await builderStore(base)
  scriptClaude(base.dir, ['auth', 'auth', 'ok'], [DOC, DOC, DOC])
  const clock = manualClock(NOW)
  const { queue } = builderRig(db, builderDeps(db, base.dir), { now: clock.now })

  // Act
  await runQueue(queue)
  const paused = onlyWork(db)
  for (let probe = 0; probe < 2; probe += 1) {
    clock.advance(AUTH_PAUSE_MS)
    await runQueue(queue)
  }

  // Assert
  assert.deepEqual([paused.state, paused.attempts], ['queued', 0])
  const app = appOf(db, APP_ID)
  assert.ok(app.state === 'in-review' || app.state === 'ready', `went to review, not ${app.state}`)
  assert.equal(app.warnings.some((w) => w.code === 'missing-cv'), false)
  assert.deepEqual([onlyWork(db).state, onlyWork(db).attempts], ['done', 0])
  assert.equal(queue.pausedUntil(), null)
})

test('what the run needs and cannot read is a failed attempt with its reason, and Claude is never called', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  const { queue } = builderRig(db, builderDeps(db, base.dir, { sources: () => fail('module-error', 'cv-maestro.md could not be read') }))
  await runQueue(queue)

  assert.deepEqual([onlyWork(db).attempts, onlyWork(db).reason], [1, 'cv-maestro.md could not be read'])
  assert.equal(existsSync(join(runDir(base.dir), 'fake-claude.calls')), false)
})

test('an application that is gone is a failed attempt, not a throw', async () => {
  using base = tempBase()
  const db = await builderStore(base)
  const { queue } = builderRig(db, builderDeps(db, base.dir))
  db.tx((q) => {
    q.run(`UPDATE work SET ref = 'nobody'`)
    return { ok: true, value: undefined }
  })
  await runQueue(queue)
  assert.deepEqual([onlyWork(db).attempts, onlyWork(db).reason], [1, 'no such application'])
})
