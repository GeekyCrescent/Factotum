import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretSkillsConfig } from './config.ts'

test('no block at all is off: it is how a fresh clone looks', () => {
  assert.deepEqual(interpretSkillsConfig(undefined), { kind: 'off' })
})

test('an absolute path is on', () => {
  assert.deepEqual(interpretSkillsConfig({ notes: '/Users/me/notes/skills.md' }), { kind: 'on', notes: '/Users/me/notes/skills.md' })
})

test('a block that is wrong is invalid, with a reason that names the key', () => {
  const cases: readonly unknown[] = [{ notes: 3 }, { notes: 'relative/skills.md' }, { notes: '/a\0b' }, { notes: '' }, {}, 'text', null, [], { notes: '/a', extra: 1 }]
  for (const raw of cases) {
    const result = interpretSkillsConfig(raw)
    assert.equal(result.kind, 'invalid', JSON.stringify(raw))
    if (result.kind === 'invalid') assert.match(result.reason, /^skills/)
  }
})

test('a reason never carries the value it rejected', () => {
  const result = interpretSkillsConfig({ notes: 'secret-relative-path' })
  assert.equal(result.kind, 'invalid')
  if (result.kind === 'invalid') assert.doesNotMatch(result.reason, /secret-relative-path/)
})
