import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type Db } from './db.ts'
import * as repo from './repo.ts'
import { application, NOW, valueOf } from '../test-state.ts'
import { tempBase, type TempBase } from '../test-support.ts'
import { ok, type Artifacts, type Opportunity } from '../types.ts'

// The queries the seed import needs (tasks S5): lookups by the natural keys, and the artifacts.

const note = { kind: 'imported' } as const

const company: repo.NewCompany = {
  id: 'company-1',
  name: 'Acme Pty Ltd',
  nameKey: 'acme',
  domain: 'acme.example',
  website: 'https://acme.example',
  careersUrl: null,
  linkedin: null,
  sector: null,
  size: null,
  location: null,
  isHealthEmployer: false,
  healthSource: null,
  ats: null,
  record: '',
}

const opportunity: Opportunity = {
  id: 'opp-1',
  companyId: 'company-1',
  kind: 'outreach',
  title: 'Engineer',
  goalId: null,
  url: null,
  postedAt: null,
  closesAt: null,
  startsAt: null,
  duration: null,
  hours: null,
  salary: null,
  requirements: '',
  score: null,
  breakdown: null,
  profileVersion: null,
  source: 'seed',
  sourceRef: null,
  remote: null,
  status: 'open',
  discardReason: null,
  checkedAt: null,
}

const artifacts: Artifacts = {
  version: 1,
  cv: null,
  pdf: null,
  png: null,
  contactHash: null,
  letter: { subject: 'Hello', body: 'Hi,\n\n{signature}' },
  form: [{ question: 'Right to work?', answer: 'Yes.', ok: true, hint: 'tick the visa box' }],
  skills: { tick: ['TypeScript'], doNotTick: ['Java'] },
  linkedin: 'Hi there',
  profileVersion: 1,
  rules: [],
  usage: null,
  origin: 'seed',
}

async function opened(base: TempBase): Promise<Db> {
  const result = await openDb({ dir: base.dir, now: () => NOW })
  if (!result.ok) assert.fail(result.error.reason)
  const db = result.value
  valueOf(
    db.tx((q) => {
      repo.insertCompany(q, company, note, NOW)
      repo.insertOpportunity(q, opportunity, 'seed:acme', note, NOW)
      repo.insertApplication(q, application({ id: 'app-1', opportunityId: 'opp-1', target: { contactId: null, to: null, url: null, contactName: null, instruction: null } }), { seedKey: '02.md#3' }, note, NOW)
      return ok(undefined)
    }),
  )
  return db
}

test('a company is found by its nameKey, an opportunity by its dedupe key, an application by its seed key', async () => {
  using base = tempBase()
  const db = await opened(base)
  db.read((q) => {
    assert.equal(repo.companyByNameKey(q, 'acme')?.id, 'company-1')
    assert.equal(repo.companyByNameKey(q, 'other'), undefined)
    assert.equal(repo.opportunityIdByDedupeKey(q, 'seed:acme'), 'opp-1')
    assert.equal(repo.opportunityIdByDedupeKey(q, 'seed:other'), undefined)
    assert.equal(repo.applicationBySeedKey(q, '02.md#3')?.id, 'app-1')
    assert.equal(repo.applicationBySeedKey(q, '02.md#4'), undefined)
  })
  db.close()
})

test('artifacts round-trip by application and version, frozen, and carry no event of their own', async () => {
  using base = tempBase()
  const db = await opened(base)
  const before = db.read((q) => q.all('SELECT id FROM events').length)
  valueOf(db.tx((q) => ok(repo.insertArtifacts(q, 'app-1', artifacts, NOW))))
  const read = db.read((q) => repo.getArtifacts(q, 'app-1', 1))
  assert.deepEqual(read, artifacts)
  assert.ok(Object.isFrozen(read) && Object.isFrozen(read?.form[0]))
  assert.equal(db.read((q) => repo.getArtifacts(q, 'app-1', 2)), undefined)
  assert.equal(db.read((q) => q.all('SELECT id FROM events').length), before)
  db.close()
})
