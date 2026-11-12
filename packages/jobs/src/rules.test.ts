import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deleteRule, enabledRules, saveRule } from './rules.ts'
import { openDb, type Db } from './store/db.ts'
import { listRules } from './store/repo.ts'
import { errorOf, NOW, valueOf } from './test-state.ts'
import { manualClock, tempBase, type TempBase } from './test-support.ts'
import { fail, ok } from './types.ts'

async function store(base: TempBase): Promise<Db> {
  const opened = await openDb({ dir: base.dir, now: () => NOW })
  if (!opened.ok) assert.fail(opened.error.reason)
  return opened.value
}

let next = 0
const ctx = { now: () => NOW, newId: () => `rule-${(next += 1)}` }

test('a rule is text of 1–300, a scope and on by default; saving one leaves rule-saved', async () => {
  using base = tempBase()
  const db = await store(base)
  const saved = valueOf(saveRule(db, { text: '  Never say "passionate".  ', scope: 'all' }, ctx)).saved
  assert.deepEqual({ ...saved, id: 'x' }, { id: 'x', text: 'Never say "passionate".', scope: 'all', enabled: true, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
  assert.ok(valueOf(saveRule(db, { text: 'x'.repeat(300), scope: 'email' }, ctx)))
  const events = db.read((q) => q.all<{ kind: string }>('SELECT kind FROM events'))
  assert.deepEqual(events.map((e) => e.kind), ['rule-saved', 'rule-saved'])
  db.close()
})

test('a rule of 301 characters, an empty one, an unknown scope or key is invalid with its field', async () => {
  using base = tempBase()
  const db = await store(base)
  for (const [input, field] of [
    [{ text: 'x'.repeat(301), scope: 'all' }, 'text'],
    [{ text: '   ', scope: 'all' }, 'text'],
    [{ text: 'ok', scope: 'fax' }, 'scope'],
    [{ text: 'ok', scope: 'all', colour: 'red' }, 'colour'],
    ['a rule', 'body'],
  ] as const) {
    const result = saveRule(db, input, ctx)
    errorOf(result, 'invalid')
    if (!result.ok) assert.equal(result.error.field, field)
  }
  assert.deepEqual(db.read((q) => listRules(q)), [])
  db.close()
})

test('editing a rule changes only what is given, keeps its id and createdAt, and logs it', async () => {
  using base = tempBase()
  const db = await store(base)
  const clock = manualClock(NOW)
  const created = valueOf(saveRule(db, { text: 'Never say passionate', scope: 'all' }, { now: clock.now, newId: () => 'r1' })).saved
  clock.advance(60_000)
  const edited = valueOf(saveRule(db, { scope: 'linkedin' }, { now: clock.now }, 'r1')).saved
  assert.deepEqual([edited.id, edited.text, edited.scope, edited.createdAt], ['r1', 'Never say passionate', 'linkedin', created.createdAt])
  assert.notEqual(edited.updatedAt, created.updatedAt)
  errorOf(saveRule(db, { scope: 'all' }, ctx, 'nope'), 'not-found')
  errorOf(saveRule(db, {}, ctx, 'r1'), 'invalid')
  db.close()
})

test('«Delete» switches the rule off, never removes it', async () => {
  using base = tempBase()
  const db = await store(base)
  valueOf(saveRule(db, { text: 'Always mention Sydney', scope: 'all' }, { now: () => NOW, newId: () => 'r1' }))
  const deleted = valueOf(deleteRule(db, 'r1', ctx)).saved
  assert.equal(deleted.enabled, false)
  assert.deepEqual(db.read((q) => listRules(q)).map((r) => [r.id, r.enabled]), [['r1', false]])
  const data = db.read((q) => q.all<{ data: string }>("SELECT data FROM events ORDER BY rowid")).map((e) => JSON.parse(e.data))
  assert.deepEqual(data.at(-1), { deleted: true, ruleId: 'r1' })
  errorOf(deleteRule(db, 'nope', ctx), 'not-found')
  db.close()
})

test('the hook runs in the same transaction and a !ok rolls the rule back', async () => {
  using base = tempBase()
  const db = await store(base)
  const result = saveRule(db, { text: 'Never say passionate', scope: 'all' }, { ...ctx, afterSave: () => fail('module-error', 'relint failed') })
  errorOf(result, 'module-error')
  assert.deepEqual(db.read((q) => listRules(q)), [])
  assert.equal(db.read((q) => q.all('SELECT id FROM events').length), 0)
  const hooked = valueOf(saveRule(db, { text: 'Never say passionate', scope: 'all' }, { ...ctx, afterSave: (q, saved) => ok(listRules(q).some((r) => r.id === saved.id)) }))
  assert.equal(hooked.hook, true)
  const off = deleteRule(db, hooked.saved.id, { ...ctx, afterSave: () => fail('module-error', 'relint failed') })
  errorOf(off, 'module-error')
  assert.equal(db.read((q) => listRules(q))[0]?.enabled, true)
  db.close()
})

test('the rules a prompt gets: enabled, scoped to all or to its channel', async () => {
  using base = tempBase()
  const db = await store(base)
  let n = 0
  const ids = { now: () => NOW, newId: () => `r${(n += 1)}` }
  valueOf(saveRule(db, { text: 'for all', scope: 'all' }, ids))
  valueOf(saveRule(db, { text: 'for email', scope: 'email' }, ids))
  valueOf(saveRule(db, { text: 'for form', scope: 'form' }, ids))
  valueOf(saveRule(db, { text: 'off', scope: 'all', enabled: false }, ids))
  assert.deepEqual(db.read((q) => enabledRules(q, 'email')).map((r) => r.text), ['for all', 'for email'])
  db.close()
})
