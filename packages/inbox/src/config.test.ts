import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ID_PATTERN, MODEL_NAME, parseInboxConfig } from './config.ts'

const ACCOUNT = {
  id: 'personal',
  label: 'Gmail',
  host: 'imap.gmail.com',
  user: 'you@gmail.com',
  passwordFile: '/Users/you/.factotum/secrets/gmail-personal',
}

function reasonOf(raw: unknown): string {
  const parsed = parseInboxConfig(raw)
  assert.equal(parsed.ok, false)
  return parsed.ok ? '' : parsed.reason
}

test('the defaults: haiku, no effort, 48 h, 30 days, unread for the account and all for a source', () => {
  const parsed = parseInboxConfig({
    accounts: [{ ...ACCOUNT, sources: [{ id: 'mq', label: 'Macquarie', address: ' You@Students.MQ.edu.au ' }] }],
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.config.model, 'haiku')
  assert.equal(parsed.config.effort, undefined)
  assert.equal('effort' in parsed.config, false)
  assert.equal(parsed.config.windowHours, 48)
  assert.equal(parsed.config.keepDays, 30)
  const [account] = parsed.config.accounts
  assert.equal(account?.read, 'unread')
  assert.deepEqual(account?.sources, [{ id: 'mq', label: 'Macquarie', address: 'you@students.mq.edu.au', read: 'all' }])
})

test('an unknown key is refused at every level, naming the key and never a value (criterion 1)', () => {
  assert.match(reasonOf({ accounts: [ACCOUNT], windowHour: 12 }), /^inbox: .*windowHour/)
  assert.match(reasonOf({ accounts: [{ ...ACCOUNT, pasword: 'hunter2hunter2' }] }), /^inbox\.accounts\.0: .*pasword/)
  const nested = reasonOf({ accounts: [{ ...ACCOUNT, sources: [{ id: 'mq', label: 'MQ', address: 'a@b.cd', extra: 1 }] }] })
  assert.match(nested, /^inbox\.accounts\.0\.sources\.0: /)
  assert.doesNotMatch(reasonOf({ accounts: [{ ...ACCOUNT, pasword: 'hunter2hunter2' }] }), /hunter2/)
})

test('a relative passwordFile is refused without its value (criterion 1)', () => {
  const reason = reasonOf({ accounts: [{ ...ACCOUNT, passwordFile: 'secrets/abcd efgh ijkl mnop' }] })
  assert.match(reason, /^inbox\.accounts\.0\.passwordFile: passwordFile must be an absolute path/)
  assert.doesNotMatch(reason, /abcd/)
  assert.match(reasonOf({ accounts: [{ ...ACCOUNT, passwordFile: '/a/../etc/x' }] }), /must not contain/)
})

test('a model with a space, a leading dash or [1m] is refused without its value (criterion 1)', () => {
  for (const model of ['claude opus', '--dangerously-skip-permissions', 'claude-opus-5-5[1m]', 'Haiku', '']) {
    const reason = reasonOf({ model, accounts: [ACCOUNT] })
    assert.match(reason, /^inbox\.model: model must match/)
    if (model !== '') assert.equal(reason.includes(model), false, `the reason quoted ${model}`)
  }
})

test('haiku, sonnet and a full model id pass', () => {
  for (const model of ['haiku', 'sonnet', 'claude-haiku-4-5-20251001']) {
    assert.equal(parseInboxConfig({ model, accounts: [ACCOUNT] }).ok, true, model)
    assert.match(model, MODEL_NAME)
  }
})

test('effort is low, medium or high when present', () => {
  const parsed = parseInboxConfig({ effort: 'low', accounts: [ACCOUNT] })
  assert.equal(parsed.ok && parsed.config.effort, 'low')
  assert.match(reasonOf({ effort: 'max', accounts: [ACCOUNT] }), /^inbox\.effort/)
})

test('no accounts, two accounts with one id, or two sources with one id are refused', () => {
  assert.match(reasonOf({ accounts: [] }), /at least one account/)
  assert.match(reasonOf({}), /^inbox\.accounts/)
  assert.match(reasonOf({ accounts: [ACCOUNT, ACCOUNT] }), /two accounts declare the same id/)
  const source = { id: 'mq', label: 'MQ', address: 'a@b.cd' }
  assert.match(reasonOf({ accounts: [{ ...ACCOUNT, sources: [source, source] }] }), /two sources declare the same id/)
  assert.match(reasonOf(undefined), /^inbox: /)
})

test('a host with a port or a scheme, an id with a slash, and a source address with a name are refused', () => {
  assert.match(reasonOf({ accounts: [{ ...ACCOUNT, host: 'imap.gmail.com:143' }] }), /host is a bare host name/)
  assert.match(reasonOf({ accounts: [{ ...ACCOUNT, id: '../x' }] }), /an id must match/)
  const named = { id: 'mq', label: 'MQ', address: 'Me <me@mq.edu.au>' }
  assert.match(reasonOf({ accounts: [{ ...ACCOUNT, sources: [named] }] }), /one plain address/)
})

test('ID_PATTERN is the same rule as SITE_ID_PATTERN', () => {
  // A copy, because this package cannot import the module that owns the original.
  assert.equal(ID_PATTERN.source, '^[a-z0-9][a-z0-9-]*$')
})
