import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as jobs from './index.ts'
import type { CreateJobs } from './index.ts'

test('C1 index: the composition root gets createJobs as a CreateJobs, and the CLI its plain functions over the store', () => {
  const factory: CreateJobs = jobs.createJobs
  assert.equal(typeof factory, 'function')
  for (const name of ['createJobs', 'createTestApplication', 'closeApplication', 'openDb'] as const) assert.equal(typeof jobs[name], 'function', name)
  assert.equal(jobs.DB_FILE, 'jobs.db')
})
