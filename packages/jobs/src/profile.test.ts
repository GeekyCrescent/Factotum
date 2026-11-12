import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { currentProfile, ensureProfile, loadProfileSeed, parseProfile, saveProfile } from './profile.ts'
import { openDb, type Db } from './store/db.ts'
import { latestProfileVersion } from './store/repo.ts'
import { errorOf, NOW, valueOf } from './test-state.ts'
import { tempBase, type TempBase } from './test-support.ts'
import { fail, ok, type Profile } from './types.ts'

const SEED_PATH = new URL('../assets/profile-seed.json', import.meta.url)
const seedProfile = (): Profile => JSON.parse(readFileSync(SEED_PATH, 'utf8')) as Profile

async function store(base: TempBase): Promise<Db> {
  const opened = await openDb({ dir: base.dir, now: () => NOW })
  if (!opened.ok) assert.fail(opened.error.reason)
  return opened.value
}

const edited = (patch: (p: Profile) => Profile): Profile => patch(seedProfile())

test('the seed file passes the zod of Profile, with the phone, the absence and the owner\'s answers of 13 Nov', () => {
  const profile = valueOf(loadProfileSeed())
  assert.equal(profile.identity.phone, '+61 401 555 638')
  assert.equal(profile.identity.portfolioUrl, 'https://geekycrescent.github.io/')
  assert.equal(profile.identity.suburb, 'Sydney')
  assert.equal(profile.identity.timezone, 'Australia/Sydney')
  assert.equal(profile.preferences.rateExpectation, '')
  assert.deepEqual(profile.absences, [{ from: '2026-11-26', to: '2027-01-10', label: 'Away from Sydney' }])
  assert.match(profile.availability, /mid-July 2027/)
  assert.deepEqual(profile.confidential, ['Christus Muguerza', 'Médica Sur', 'Secretaría de Salud', 'IMSS'])
  assert.ok(profile.identity.cvAvailabilityLine.length > 0 && profile.identity.cvAvailabilityLine.length <= 120)
  assert.equal(profile.goals.length, 4)
  assert.equal(Object.values(profile.weights).reduce((a, b) => a + b, 0), 100)
})

test('a seed that is not JSON, or not a profile, is a Result and never a throw', () => {
  errorOf(loadProfileSeed(() => '{ not json'), 'module-error')
  errorOf(loadProfileSeed(() => JSON.stringify({ identity: {} })), 'module-error')
  errorOf(
    loadProfileSeed(() => {
      throw new Error('ENOENT')
    }),
    'module-error',
  )
})

test('an empty store takes the seed as version 1; with a version saved the file is not read again', async () => {
  using base = tempBase()
  const db = await store(base)
  let reads = 0
  const readSeed = (): string => {
    reads += 1
    return readFileSync(SEED_PATH, 'utf8')
  }
  const first = valueOf(ensureProfile(db, { now: () => NOW, readSeed }))
  assert.equal(first.version, 1)
  assert.equal(first.profile.identity.phone, '+61 401 555 638')
  assert.equal(reads, 1)
  const again = valueOf(ensureProfile(db, { now: () => NOW, readSeed }))
  assert.equal(again.version, 1)
  assert.equal(reads, 1, 'the file is never read again')
  assert.deepEqual(db.read((q) => q.all<{ kind: string; data: string }>('SELECT kind, data FROM events')).map((e) => [e.kind, JSON.parse(e.data)]), [
    ['profile-saved', { seeded: true, version: 1 }],
  ])
  db.close()
})

test('a bad seed on an empty store is refused, and nothing is written', async () => {
  using base = tempBase()
  const db = await store(base)
  errorOf(ensureProfile(db, { now: () => NOW, readSeed: () => '[]' }), 'module-error')
  assert.equal(db.read((q) => latestProfileVersion(q)), undefined)
  db.close()
})

test('saving creates a new version and never rewrites the old one', async () => {
  using base = tempBase()
  const db = await store(base)
  valueOf(ensureProfile(db, { now: () => NOW }))
  const input = edited((p) => ({ ...p, identity: { ...p.identity, phone: '+61 400 000 000' } }))
  const saved = valueOf(saveProfile(db, input, { now: () => NOW }))
  assert.equal(saved.saved.version, 2)
  assert.equal(saved.saved.createdAt, NOW.toISOString())
  assert.equal(db.read((q) => currentProfile(q))?.profile.identity.phone, '+61 400 000 000')
  const v1 = db.read((q) => q.get<{ data: string }>('SELECT data FROM profile_versions WHERE version = 1'))
  assert.equal((JSON.parse(v1?.data ?? '{}') as Profile).identity.phone, '+61 401 555 638')
  db.close()
})

test('the hook runs inside the same transaction and sees the new version', async () => {
  using base = tempBase()
  const db = await store(base)
  let seen: number | undefined
  const result = valueOf(
    saveProfile(db, seedProfile(), {
      now: () => NOW,
      afterSave: (q, saved) => {
        seen = latestProfileVersion(q)?.version
        return ok(saved.version * 10)
      },
    }),
  )
  assert.equal(seen, 1)
  assert.equal(result.hook, 10)
  db.close()
})

test('a !ok from the hook rolls the version back, with its event', async () => {
  using base = tempBase()
  const db = await store(base)
  const result = saveProfile(db, seedProfile(), { now: () => NOW, afterSave: () => fail('module-error', 'relint failed') })
  errorOf(result, 'module-error', 'relint failed')
  assert.equal(db.read((q) => latestProfileVersion(q)), undefined)
  assert.equal(db.read((q) => q.all('SELECT id FROM events').length), 0)
  db.close()
})

// Each refusal names its field, and the reason never carries the value (requirements crit. 14).
const refused: readonly { readonly name: string; readonly input: unknown; readonly field: string; readonly secret?: string }[] = [
  { name: 'not an object', input: 'profile', field: 'body' },
  { name: 'an unknown key', input: { ...seedProfile(), favouriteColour: 'secret-blue' }, field: 'favouriteColour', secret: 'secret-blue' },
  {
    name: 'a cvAvailabilityLine with a line break',
    input: edited((p) => ({ ...p, identity: { ...p.identity, cvAvailabilityLine: 'Available\nsecret-line' } })),
    field: 'identity.cvAvailabilityLine',
    secret: 'secret-line',
  },
  {
    name: 'a cvAvailabilityLine of 121 characters',
    input: edited((p) => ({ ...p, identity: { ...p.identity, cvAvailabilityLine: 'x'.repeat(121) } })),
    field: 'identity.cvAvailabilityLine',
  },
  { name: 'weights that do not add up to 100', input: edited((p) => ({ ...p, weights: { ...p.weights, partTime: 31 } })), field: 'weights' },
  { name: 'a batch of 21', input: edited((p) => ({ ...p, batchSize: 21 })), field: 'batchSize' },
  {
    name: 'an absence that ends before it starts',
    input: edited((p) => ({ ...p, absences: [{ from: '2027-01-10', to: '2026-11-26', label: 'x' }] })),
    field: 'absences.0',
  },
  { name: 'an absence that is not a day', input: edited((p) => ({ ...p, absences: [{ from: '2026-02-30', to: '2026-03-01', label: 'x' }] })), field: 'absences.0.from' },
  {
    name: 'a goal source that is not a scout source',
    input: edited((p) => ({ ...p, goals: [{ ...p.goals[0], sources: ['gradconnection'] } as unknown as Profile['goals'][number]] })),
    field: 'goals.0.sources.0',
  },
  {
    name: 'a follow-up template with {contact}',
    input: edited((p) => ({ ...p, followup: { ...p.followup, first: 'Hi {contact}, secret-text' } })),
    field: 'followup.first',
    secret: 'secret-text',
  },
  { name: 'a follow-up template with [x]', input: edited((p) => ({ ...p, followup: { ...p.followup, second: 'Hi [x]' } })), field: 'followup.second' },
  { name: 'a follow-up template with TODO', input: edited((p) => ({ ...p, followup: { ...p.followup, subject: 'TODO subject' } })), field: 'followup.subject' },
  { name: 'a follow-up template with TBD', input: edited((p) => ({ ...p, followup: { ...p.followup, first: 'rate TBD' } })), field: 'followup.first' },
  {
    name: 'a LinkedIn template with {signature}',
    input: edited((p) => ({ ...p, followup: { ...p.followup, linkedin: 'Hi {greetingName}. {signature}' } })),
    field: 'followup.linkedin',
  },
  { name: 'a LinkedIn template over 280', input: edited((p) => ({ ...p, followup: { ...p.followup, linkedin: 'x'.repeat(281) } })), field: 'followup.linkedin' },
]

for (const { name, input, field, secret } of refused) {
  test(`${name} is invalid with field ${field}`, () => {
    const parsed = parseProfile(input)
    errorOf(parsed, 'invalid')
    if (parsed.ok) return
    assert.equal(parsed.error.field, field)
    if (secret !== undefined) assert.ok(!parsed.error.reason.includes(secret), parsed.error.reason)
  })
}

test('a refused save writes nothing', async () => {
  using base = tempBase()
  const db = await store(base)
  errorOf(saveProfile(db, { nope: true }, { now: () => NOW }), 'invalid')
  assert.equal(db.read((q) => latestProfileVersion(q)), undefined)
  db.close()
})

test('every allowed field passes in a template, and an empty phone is a valid profile (the linter blocks, not the zod)', () => {
  const input = edited((p) => ({
    ...p,
    identity: { ...p.identity, phone: '', portfolioUrl: '' },
    followup: { ...p.followup, first: '{greetingName} {role} {company} {sentDate} {signature}' },
  }))
  assert.ok(parseProfile(input).ok)
})
