/**
 * C1 — the facade's lifecycle (design D13): a start that fails half-way leaves nothing armed and the
 * store closed; `stop` survives a stopper that fails and waits for what is still writing.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { queueStore } from './ai/test-queue.ts'
import { createJobs } from './jobs.ts'
import { seedProfile } from './seed/test-seed.ts'
import * as repo from './store/repo.ts'
import { depsOf, NOW, rigIn, started } from './test-jobs.ts'
import { valueOf } from './test-state.ts'
import { manualTimers, tempBase } from './test-support.ts'
import { ok } from './types.ts'

test('C1 start: a step that throws after the store opened → off with its reason, no interval armed, the store closed', async () => {
  using base = tempBase()
  const rig = rigIn(base.dir)
  const db = await queueStore({ dir: rig.stateDir, [Symbol.dispose]: () => undefined })
  valueOf(
    db.tx((q) => {
      repo.insertProfileVersion(q, { version: 2, createdAt: NOW.toISOString(), profile: seedProfile() }, { kind: 'profile-saved' }, NOW)
      // A never-checked contact, and an `address-checked` event the restart query cannot parse: step 4 throws.
      q.run(`UPDATE contacts SET address_status = 'unverified', checked_at = NULL`)
      q.run(`INSERT INTO events (id, at, recorded_at, kind, data) VALUES ('bad', ?, ?, 'address-checked', 'not json')`, NOW.toISOString(), NOW.toISOString())
      return ok(undefined)
    }),
  )
  db.close()
  const manual = manualTimers()

  const deps = depsOf(rig, { timers: manual.timers })
  const created = await createJobs(deps)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(created.ok, false)
  assert.match(created.ok ? '' : created.reason, /^jobs could not start \(/)
  assert.equal(manual.tick(), 0, 'no interval left armed')
  assert.equal(existsSync(join(rig.stateDir, 'jobs.db-wal')), false, 'the store is closed')
  assert.deepEqual(deps.captured.lines.filter((line) => /not open|is closed/.test(line)), [], 'nothing ran on the closed store')
})

test('C1 stop: waits for an import in flight before closing the store; an import asked once stopping is refused', async () => {
  using base = tempBase()
  const deps = depsOf(rigIn(base.dir))
  const jobs = await started(deps)

  const importing = jobs.importSeed({ dryRun: false }) // reads the vault first: nothing written yet
  const stopping = jobs.stop()
  const late = await jobs.importSeed({ dryRun: false })
  const report = await importing
  await stopping

  assert.ok(report.ok, report.ok ? '' : report.error.reason)
  assert.deepEqual(late.ok ? null : late.error, { code: 'conflict', reason: 'stopping' })
  assert.deepEqual(deps.captured.lines.filter((line) => /not open|is closed/.test(line)), [], 'nothing ran on the closed store')
})
