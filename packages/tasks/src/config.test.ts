import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTasksConfig } from './config.ts'

test('an empty block is a board in the zone of the process, with sonnet and no effort (A2)', () => {
  const parsed = parseTasksConfig({})
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  assert.equal(parsed.config.mode, 'board')
  assert.equal(parsed.config.model, 'sonnet')
  assert.equal(parsed.config.effort, undefined)
  assert.equal(parsed.config.effort, undefined)
  assert.equal(parsed.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone)
})

test('an explicit zone wins over the process (S7)', () => {
  const parsed = parseTasksConfig({ mode: 'board', timeZone: 'Australia/Sydney', model: 'sonnet', effort: 'low' })
  assert.ok(parsed.ok)
  if (parsed.ok) assert.equal(parsed.timeZone, 'Australia/Sydney')
})

test('relay names the host of the board', () => {
  const parsed = parseTasksConfig({ mode: 'relay', relayTo: 'omarchy' })
  assert.ok(parsed.ok)
  if (parsed.ok) assert.equal(parsed.config.relayTo, 'omarchy')
})

// Criterion 1: each bad block switches off tasks alone, with a reason that never carries the value.
const bad: readonly { readonly name: string; readonly raw: unknown; readonly path: string; readonly secret: string }[] = [
  { name: 'an unknown key', raw: { timezone: 'Mars/Olympus' }, path: 'tasks', secret: 'Mars/Olympus' },
  { name: 'a zone Intl does not accept', raw: { timeZone: 'Mars/Olympus' }, path: 'tasks.timeZone', secret: 'Mars/Olympus' },
  { name: 'a model that is not a model name', raw: { model: '--dangerously-skip' }, path: 'tasks.model', secret: 'dangerously' },
  { name: 'a model with a space', raw: { model: 'opus [1m]' }, path: 'tasks.model', secret: '[1m]' },
  { name: 'an effort that does not exist', raw: { effort: 'maximum-overdrive' }, path: 'tasks.effort', secret: 'overdrive' },
  { name: 'a mode that does not exist', raw: { mode: 'mirror-mode' }, path: 'tasks.mode', secret: 'mirror' },
  { name: 'relay without relayTo', raw: { mode: 'relay' }, path: 'tasks.relayTo', secret: '' },
  { name: 'relayTo on a board', raw: { relayTo: 'secret-host' }, path: 'tasks.relayTo', secret: 'secret-host' },
  { name: 'a relayTo that is not a machine name', raw: { mode: 'relay', relayTo: 'a/../b' }, path: 'tasks.relayTo', secret: '../' },
  { name: 'not an object', raw: 'board', path: 'tasks', secret: '' },
]

for (const { name, raw, path, secret } of bad) {
  test(`${name} is refused with its path, and the reason does not carry the value`, () => {
    const parsed = parseTasksConfig(raw)
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.ok(parsed.reason.startsWith(`${path}:`), parsed.reason)
    if (secret !== '') assert.ok(!parsed.reason.includes(secret), parsed.reason)
  })
}
