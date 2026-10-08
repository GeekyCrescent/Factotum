import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Logger } from '@factotum/core'
import { createPeerTable, machineName } from './peers.ts'
import { REFUSED_RESTS } from '../test-support.ts'

const MAC = 'https://juans-macbook-pro.tailbd0167.ts.net:8443'

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

const table = (origins: readonly string[] = [MAC]) =>
  createPeerTable({ peers: origins.map((origin) => ({ origin })), log: silent })

// ---------------------------------------------------------------------------
// machineName: one place, because a host's name is its key everywhere
// ---------------------------------------------------------------------------

test('machineName is the first label of the hostname, without port or tailnet', () => {
  assert.equal(machineName(MAC), 'juans-macbook-pro')
  assert.equal(machineName('https://omarchy.tailbd0167.ts.net'), 'omarchy')
  assert.equal(machineName('http://localhost:7777'), 'localhost')
  // Why the tests pair `localhost` with `127.0.0.1` and never two of the same (design D2).
  assert.equal(machineName('http://127.0.0.1:7777'), '127')
})

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

test('a peer starts unreachable and never seen: nothing has asked it yet', () => {
  const peers = table()
  assert.deepEqual(peers.list(), [
    { name: 'juans-macbook-pro', origin: MAC, reachable: false, lastSeenAt: undefined, version: undefined, devices: 0 },
  ])
})

test('get finds a peer by its name, and nothing else', () => {
  const peers = table()
  assert.equal(peers.get('juans-macbook-pro')?.origin, MAC)
  assert.equal(peers.get('omarchy'), undefined)
  assert.equal(peers.get(MAC), undefined)
})

test('no peers is an empty table', () => {
  assert.deepEqual(table([]).list(), [])
})

// ---------------------------------------------------------------------------
// url(name, rawRest): the table of criterion 6 (design D3), every row
// ---------------------------------------------------------------------------

test('every malicious rest of criterion 6 builds no URL', () => {
  const peers = table()
  for (const rest of REFUSED_RESTS) assert.equal(peers.url('juans-macbook-pro', rest), undefined, rest)
})

test('the rests that must pass build a URL on the peer’s own origin, query untouched', () => {
  const peers = table()
  const cases: readonly (readonly [string, string])[] = [
    ['/modules/sessions/sessions?page=0', `${MAC}/modules/sessions/sessions?page=0`],
    // A search for a text with `/` in it: the query is never looked at, so `%2F` passes there.
    ['/modules/sessions/search?q=src%2Fapp', `${MAC}/modules/sessions/search?q=src%2Fapp`],
    ['/health', `${MAC}/health`],
  ]
  for (const [rest, want] of cases) {
    const out = peers.url('juans-macbook-pro', rest)
    assert.equal(out?.href, want, rest)
    assert.equal(out?.origin, MAC)
  }
})

test('more shapes that must not leave: dot segments, encoded escapes, a module id that is not one', () => {
  const peers = table()
  for (const rest of [
    '/modules/sessions/./x',
    '/modules/sessions/..',
    '/modules/sessions/%2E%2E/x',
    '/modules/sessions/a%5cb',
    '/modules/sessions/a\\b',
    '/modules/Sessions/x',
    '/modules/-x/y',
    '/modules',
    '/modules/',
    '/health/x',
    '/healthz',
    'modules/sessions/x',
    '/modules/sessions/a#b',
  ]) {
    assert.equal(peers.url('juans-macbook-pro', rest), undefined, rest)
  }
})

test('a name that is not a peer builds nothing', () => {
  const peers = table()
  assert.equal(peers.url('omarchy', '/health'), undefined)
  assert.equal(peers.url('', '/health'), undefined)
})

test('a module path with its own segments and a token in it passes untouched', () => {
  const peers = table()
  const out = peers.url('juans-macbook-pro', '/modules/sessions/asks/0a1b-TOKEN_x.y~z/answer')
  assert.equal(out?.pathname, '/modules/sessions/asks/0a1b-TOKEN_x.y~z/answer')
})
