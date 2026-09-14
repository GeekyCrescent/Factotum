import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findInvokable, resolveCatalog } from './catalog.ts'
import type { CatalogEntry } from './types.ts'

const entry = (id: string, kind: string, name?: string): CatalogEntry => ({
  id,
  label: id,
  invoke: { kind, name },
})

test('the three kinds resolve', () => {
  const resolved = resolveCatalog([
    entry('free', 'none'),
    entry('review', 'command', 'code-review'),
    entry('planner', 'subagent', 'ecc:planner'),
  ])
  assert.deepEqual(
    resolved.map((r) => r.invoke),
    [{ kind: 'none' }, { kind: 'command', name: 'code-review' }, { kind: 'subagent', name: 'ecc:planner' }],
  )
  assert.equal(resolved.every((r) => r.disabledReason === undefined), true)
})

// ---------------------------------------------------------------------------
// Criterion 14: one broken entry, and the rest of the catalog keeps working
// ---------------------------------------------------------------------------

test('an unknown kind is disabled with the reason and the rest still resolve', () => {
  const resolved = resolveCatalog([
    entry('free', 'none'),
    entry('weird', 'skill', 'x'),
    entry('review', 'command', 'code-review'),
  ])
  assert.equal(resolved[1]?.invoke, undefined)
  assert.match(resolved[1]?.disabledReason ?? '', /invoke\.kind "skill" is not one of/)
  // The point of the criterion: the neighbours are untouched.
  assert.deepEqual(resolved[0]?.invoke, { kind: 'none' })
  assert.deepEqual(resolved[2]?.invoke, { kind: 'command', name: 'code-review' })
})

test('a command with no name is disabled, not guessed at', () => {
  const [only] = resolveCatalog([entry('review', 'command')])
  assert.match(only?.disabledReason ?? '', /needs a name/)
})

test('a command with an empty name is disabled', () => {
  const [only] = resolveCatalog([entry('review', 'command', '')])
  assert.match(only?.disabledReason ?? '', /needs a name/)
})

test('a name with whitespace is disabled, because it would become a different command', () => {
  // `/my command x` is `/my` with two arguments, which is not what anyone wrote.
  const [only] = resolveCatalog([entry('review', 'command', 'my command')])
  assert.match(only?.disabledReason ?? '', /is not a name the CLI can be given/)
})

test('a name with a leading slash is disabled, because the caller adds the slash', () => {
  const [only] = resolveCatalog([entry('review', 'command', '/code-review')])
  assert.match(only?.disabledReason ?? '', /is not a name the CLI can be given/)
})

test('a duplicate id disables the SECOND one and keeps the first', () => {
  const resolved = resolveCatalog([entry('dup', 'none'), entry('dup', 'command', 'x')])
  assert.deepEqual(resolved[0]?.invoke, { kind: 'none' })
  assert.match(resolved[1]?.disabledReason ?? '', /already uses the id/)
})

// ---------------------------------------------------------------------------
// findInvokable
// ---------------------------------------------------------------------------

test('a known, healthy entry is invokable', () => {
  const resolved = resolveCatalog([entry('free', 'none')])
  assert.deepEqual(findInvokable(resolved, 'free'), { ok: true, invoke: { kind: 'none' } })
})

test('an entry nobody declared is refused with a reason a person can read', () => {
  const result = findInvokable(resolveCatalog([]), 'ghost')
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /no catalog entry "ghost"/)
})

test('a disabled entry is refused, and the refusal carries WHY it is disabled', () => {
  const resolved = resolveCatalog([entry('weird', 'skill', 'x')])
  const result = findInvokable(resolved, 'weird')
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /is disabled: invoke\.kind "skill"/)
})
